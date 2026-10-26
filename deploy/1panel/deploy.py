#!/usr/bin/env python3
"""MiGPT 的本机 Docker Compose 迁移和更新；不调用小米或火山。"""

import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


ROOT = Path('/opt/migpt-volcano-v3')
SOURCE = ROOT / 'source'
RUNTIME = ROOT / 'runtime/compose.json'
REGISTRY = Path('/etc/yklx-update/projects.conf')
CONTAINER = 'migpt-volcano-v3'
PROJECT = 'migpt-volcano-v3'
ENTRY = 'migpt|MiGPT|/opt/migpt-volcano-v3/source|main|deploy/1panel/update.sh|deploy/1panel/compose.yaml|migpt'


class DeployError(Exception):
    pass


def run(args, capture=False):
    # Docker / Compose 错误可能带配置值，捕获并只报告命令名称。
    result = subprocess.run(args, text=True, encoding='utf-8',
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE)
    if result.returncode:
        raise DeployError(f'{args[0]} {args[1]} 执行失败（退出码 {result.returncode}）；未输出可能含凭证的错误内容。')
    return result.stdout if capture else ''


def inspect_container():
    return json.loads(run(['docker', 'inspect', CONTAINER], capture=True))[0]


def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w', encoding='utf-8') as output:
        output.write(data)
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def write_json(path, data):
    write_private(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def escape_compose(value):
    # Compose 会插值环境、命令和挂载路径中的 $，保留 Docker 中的原始值。
    if isinstance(value, str):
        return value.replace('$', '$$')
    if isinstance(value, list):
        return [escape_compose(item) for item in value]
    if isinstance(value, dict):
        return {key: escape_compose(item) for key, item in value.items()}
    return value


def port_from_command(command):
    port = 36592
    for index, arg in enumerate(command or []):
        if arg in ('--port', '-p'):
            port = int(command[index + 1])
        elif arg.startswith('--port='):
            port = int(arg.split('=', 1)[1])
    if not 1 <= port <= 65535:
        raise DeployError('容器监听端口无效。')
    return port


def make_compose(old, image, source):
    config, host = old['Config'], old['HostConfig']
    if config.get('User') not in ('', None, 'root', '0', '0:0'):
        raise DeployError('当前工具只迁移 root 运行的 MiGPT，请先核对容器运行用户。')
    if host.get('AutoRemove') or host.get('VolumesFrom'):
        raise DeployError('自动删除容器或 volumes_from 无法按本方案保留，停止迁移。')
    if host.get('NetworkMode', '').startswith('container:'):
        raise DeployError('不支持共享其他容器网络命名空间，停止迁移。')

    # 仅对明确支持的 HostConfig 字段迁移；拒绝丢弃其他非默认配置。
    supported = {
        'Binds', 'Mounts', 'PortBindings', 'NetworkMode', 'RestartPolicy',
        'LogConfig', 'ShmSize', 'Runtime', 'CgroupnsMode', 'IpcMode',
        'Privileged', 'ReadonlyRootfs', 'CapAdd', 'CapDrop', 'SecurityOpt',
        'ExtraHosts', 'Dns', 'DnsOptions', 'DnsSearch', 'GroupAdd', 'Sysctls',
        'Memory', 'MemoryReservation', 'MemorySwap', 'NanoCpus', 'CpuShares',
        'CpusetCpus', 'PidsLimit', 'Init', 'Ulimits', 'Tmpfs',
    }
    defaults = {
        'ConsoleSize': [0, 0], 'MemorySwappiness': -1, 'CpuCount': 0,
        'MaskedPaths': ['/proc/asound', '/proc/acpi', '/proc/interrupts', '/proc/kcore',
                        '/proc/keys', '/proc/latency_stats', '/proc/timer_list',
                        '/proc/timer_stats', '/proc/sched_debug', '/proc/scsi', '/sys/firmware', '/sys/devices/virtual/powercap'],
        'ReadonlyPaths': ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'],
    }
    for key, value in host.items():
        if key not in supported and value not in (None, False, 0, '', [], {}):
            if key not in defaults or value != defaults[key]:
                raise DeployError(f'无法准确迁移 HostConfig.{key}，旧容器未作改动。')
    if config.get('Shell') or config.get('OnBuild'):
        raise DeployError('容器含非标准 Shell/OnBuild 配置，停止迁移。')

    service = {
        'container_name': CONTAINER,
        'image': image,
        'build': {'context': str(source), 'dockerfile': 'Dockerfile.volcano-v3'},
        'pull_policy': 'never',
        'environment': config.get('Env') or [],
        'entrypoint': config.get('Entrypoint'),
        'command': config.get('Cmd'),
        'working_dir': config.get('WorkingDir') or '/app',
        'user': config.get('User') or 'root',
        'labels': {key: value for key, value in (config.get('Labels') or {}).items()
                   if not key.startswith('com.docker.compose.')},
        'stdin_open': bool(config.get('OpenStdin')),
        'tty': bool(config.get('Tty')),
    }
    if config.get('Hostname') and config['Hostname'] != old['Id'][:12]:
        service['hostname'] = config['Hostname']
    for source_key, target_key in [('Domainname', 'domainname'), ('StopSignal', 'stop_signal')]:
        if config.get(source_key):
            service[target_key] = config[source_key]
    if config.get('StopTimeout') is not None:
        service['stop_grace_period'] = f"{config['StopTimeout']}s"
    restart = host.get('RestartPolicy') or {}
    service['restart'] = restart.get('Name') or 'no'
    if service['restart'] == 'on-failure' and restart.get('MaximumRetryCount'):
        service['restart'] += ':' + str(restart['MaximumRetryCount'])
    if host.get('LogConfig', {}).get('Type'):
        service['logging'] = {'driver': host['LogConfig']['Type'], 'options': host['LogConfig'].get('Config') or {}}
    mappings = {
        'ShmSize': 'shm_size', 'Runtime': 'runtime', 'IpcMode': 'ipc',
        'Privileged': 'privileged', 'ReadonlyRootfs': 'read_only',
        'CapAdd': 'cap_add', 'CapDrop': 'cap_drop', 'SecurityOpt': 'security_opt',
        'ExtraHosts': 'extra_hosts', 'Dns': 'dns', 'DnsOptions': 'dns_opt',
        'DnsSearch': 'dns_search', 'GroupAdd': 'group_add', 'Sysctls': 'sysctls',
        'Memory': 'mem_limit', 'MemoryReservation': 'mem_reservation',
        'MemorySwap': 'memswap_limit', 'CpuShares': 'cpu_shares',
        'CpusetCpus': 'cpuset', 'PidsLimit': 'pids_limit', 'Init': 'init',
    }
    for key, target in mappings.items():
        if host.get(key) not in (None, 0, '', [], {}):
            service[target] = host[key]
    if host.get('CgroupnsMode'):
        service['cgroup'] = host['CgroupnsMode']
    if host.get('NanoCpus'):
        service['cpus'] = host['NanoCpus'] / 1_000_000_000
    if host.get('Ulimits'):
        service['ulimits'] = {item['Name']: {'soft': item['Soft'], 'hard': item['Hard']}
                             for item in host['Ulimits']}

    ports = []
    for container_port, bindings in (host.get('PortBindings') or {}).items():
        number, protocol = container_port.split('/')
        for binding in bindings or []:
            if not binding.get('HostPort'):
                raise DeployError('发现随机分配端口，不能保证地址不变，停止迁移。')
            port = {'target': int(number), 'published': binding['HostPort'], 'protocol': protocol}
            if binding.get('HostIp'):
                port['host_ip'] = binding['HostIp']
            ports.append(port)
    if ports:
        service['ports'] = ports
    if config.get('ExposedPorts'):
        service['expose'] = list(config['ExposedPorts'])

    volumes, mounts = {}, []
    has_data = False
    for index, mount in enumerate(old.get('Mounts') or []):
        destination = mount['Destination']
        if destination == '/root/.migptgui' or '/root/.migptgui'.startswith(destination.rstrip('/') + '/'):
            has_data = True
        item = {'type': mount['Type'], 'target': destination, 'read_only': not mount.get('RW', True)}
        if mount['Type'] == 'bind':
            original = next((entry for entry in host.get('Mounts') or [] if entry.get('Target') == destination), {})
            if set(original.get('BindOptions') or {}) - {'Propagation', 'CreateMountpoint'}:
                raise DeployError('发现无法迁移的递归 bind 挂载选项。')
            item['source'] = mount['Source']
            mode = mount.get('Mode', '')
            if set(mode.split(',')) - {'', 'rw', 'ro', 'z', 'Z', 'private', 'rprivate', 'shared', 'rshared', 'slave', 'rslave'}:
                raise DeployError('发现无法迁移的 bind 挂载选项。')
            item['bind'] = {'create_host_path': False}
            if mount.get('Propagation'):
                item['bind']['propagation'] = mount['Propagation']
            if 'Z' in mode.split(',') or 'z' in mode.split(','):
                item['bind']['selinux'] = 'Z' if 'Z' in mode.split(',') else 'z'
        elif mount['Type'] == 'volume':
            name = f'data{index}'
            volumes[name] = {'external': True, 'name': mount['Name']}
            item['source'] = name
            original = next((entry for entry in host.get('Mounts') or [] if entry.get('Target') == destination), {})
            volume_options = original.get('VolumeOptions') or {}
            if set(volume_options) - {'NoCopy'}:
                raise DeployError('发现非标准 volume 挂载选项。')
            item['volume'] = {'nocopy': volume_options.get('NoCopy', False)}
        elif mount['Type'] == 'tmpfs':
            if not (host.get('Tmpfs') or {}).get(destination):
                raise DeployError('发现无法迁移的 tmpfs 挂载选项。')
            continue
        else:
            raise DeployError('发现无法迁移的挂载类型。')
        mounts.append(item)
    if not has_data:
        raise DeployError('未发现持久挂载的 /root/.migptgui，停止迁移以避免丢失数据。')
    service['volumes'] = mounts
    if host.get('Tmpfs'):
        service['tmpfs'] = [f'{key}:{value}' if value else key for key, value in host['Tmpfs'].items()]

    networks = {}
    if host.get('NetworkMode') in ('host', 'none', 'bridge', 'default'):
        service['network_mode'] = 'bridge' if host['NetworkMode'] == 'default' else host['NetworkMode']
        if len(old.get('NetworkSettings', {}).get('Networks') or {}) > 1:
            raise DeployError('默认网络模式同时附加多个网络，停止迁移。')
    else:
        endpoints = {}
        for index, (name, endpoint) in enumerate(old['NetworkSettings']['Networks'].items()):
            key = f'network{index}'
            networks[key] = {'external': True, 'name': name}
            settings = {}
            aliases = [alias for alias in endpoint.get('Aliases') or [] if alias not in (old['Id'], old['Id'][:12])]
            if aliases:
                settings['aliases'] = aliases
            ipam = endpoint.get('IPAMConfig') or {}
            for source_key, target in [('IPv4Address', 'ipv4_address'), ('IPv6Address', 'ipv6_address'), ('LinkLocalIPs', 'link_local_ips')]:
                if ipam.get(source_key):
                    settings[target] = ipam[source_key]
            if endpoint.get('DriverOpts'):
                settings['driver_opts'] = endpoint['DriverOpts']
            if endpoint.get('Links') or endpoint.get('GwPriority'):
                raise DeployError('网络包含未支持的 Links/GwPriority 设置，停止迁移。')
            endpoints[key] = settings
        service['networks'] = endpoints

    port = port_from_command(config.get('Cmd'))
    service['healthcheck'] = {
        'test': ['CMD', 'node', '-e',
                 f"fetch('http://127.0.0.1:{port}/ping',{{method:'POST',signal:AbortSignal.timeout(3000)}}).then(r=>process.exit(r.status===204?0:1)).catch(()=>process.exit(1))"],
        'interval': '3s', 'timeout': '5s', 'retries': 15, 'start_period': '10s',
    }
    model = {'name': PROJECT, 'services': {'migpt': service}}
    if volumes:
        model['volumes'] = volumes
    if networks:
        model['networks'] = networks
    return escape_compose(model)


def register_project(registry=None):
    if registry is None:
        registry = REGISTRY
    original = registry.read_text(encoding='utf-8')
    output, found = [], False
    for line in original.splitlines(keepends=True):
        if line.split('|', 1)[0] == 'migpt':
            if not found:
                output.append(ENTRY + '\n')
                found = True
        else:
            output.append(line)
    if not found:
        if output and not output[-1].endswith('\n'):
            output[-1] += '\n'
        output.append(ENTRY + '\n')
    write_private(registry, ''.join(output))


def compose(file, *args):
    return run(['docker', 'compose', '-p', PROJECT, '-f', str(file), *args], capture=True)


def safe_logs():
    output = run(['docker', 'logs', '--tail', '30', CONTAINER], capture=True)
    for line in output.splitlines():
        if line.startswith(('端口：', '登录认证：', '秘密路径：')):
            print(line)
        elif line.startswith('{'):
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if item.get('scope') == 'TTS播放':
                allowed = ('scope', 'requestId', 'event', 'elapsedMs', 'status', 'audioBytes', 'audioChunks', 'audioFailed')
                print(json.dumps({key: item[key] for key in allowed if key in item}, ensure_ascii=False))


def check_ready():
    state = inspect_container()['State']
    if not state.get('Running') or state.get('Health', {}).get('Status') != 'healthy':
        raise DeployError('新容器未通过面板健康检查。')
    time.sleep(3)
    state = inspect_container()['State']
    if not state.get('Running') or state.get('Health', {}).get('Status') != 'healthy':
        raise DeployError('新容器启动后退出或健康状态异常。')


def reconnect_old(backup_name, endpoints):
    for name, endpoint in endpoints.items():
        args = ['docker', 'network', 'connect']
        for alias in endpoint.get('Aliases') or []:
            args += ['--alias', alias]
        ipam = endpoint.get('IPAMConfig') or {}
        for key, flag in [('IPv4Address', '--ip'), ('IPv6Address', '--ip6')]:
            if ipam.get(key):
                args += [flag, ipam[key]]
        for ip in ipam.get('LinkLocalIPs') or []:
            args += ['--link-local-ip', ip]
        for key, value in (endpoint.get('DriverOpts') or {}).items():
            args += ['--driver-opt', f'{key}={value}']
        run([*args, name, backup_name], capture=True)


def deploy(action, source):
    if sys.version_info < (3, 9):
        raise DeployError('需要 Python 3.9 或更新版本。')
    if not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise DeployError('请在 Linux 服务器上使用 root 或 sudo 执行。')
    os.umask(0o077)
    if source.resolve() != SOURCE:
        raise DeployError(f'本部署固定使用 {SOURCE}，当前目录不匹配。')
    if not Path('/usr/local/bin/yklx-update').is_file() or not REGISTRY.is_file():
        raise DeployError('请先安装已有的 yklx-update 菜单和项目注册表。')
    if run(['git', '-C', str(source), 'branch', '--show-current'], capture=True).strip() != 'main':
        raise DeployError('部署分支必须是 main。')
    if run(['git', '-C', str(source), 'status', '--porcelain'], capture=True).strip():
        raise DeployError('工作区有本地修改，拒绝部署。')
    version = run(['docker', 'compose', 'version', '--short'], capture=True).strip().lstrip('v')
    match = re.match(r'(\d+)\.(\d+)', version)
    if not match or tuple(map(int, match.groups())) < (2, 20):
        raise DeployError('需要 Docker Compose 2.20 或更新版本（支持 include）。')
    ROOT.mkdir(parents=True, exist_ok=True)
    RUNTIME.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(RUNTIME.parent, 0o700)
    import fcntl
    with open(ROOT / 'deploy.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError('另一项 MiGPT 更新正在执行。') from None
        deploy_locked(action, source)


def deploy_locked(action, source):
    old = inspect_container()
    if not old['State'].get('Running'):
        raise DeployError('当前 MiGPT 容器未运行；请先恢复旧服务再迁移或更新。')
    labels = old['Config'].get('Labels') or {}
    if RUNTIME.exists():
        if labels.get('com.docker.compose.project') != PROJECT or labels.get('com.docker.compose.service') != 'migpt':
            raise DeployError('已有部署记录与当前容器归属不一致，停止部署。')
        if action == 'install':
            check_ready()
            register_project()
            print('MiGPT 已迁移，已核对菜单注册；没有重复创建容器。')
            return
    elif action != 'install' or labels.get('com.docker.compose.project'):
        raise DeployError('请先迁移独立容器，不能接管其他 Compose 项目。')

    revision = run(['git', '-C', str(source), 'rev-parse', '--short=12', 'HEAD'], capture=True).strip()
    image = f'migpt-volcano-v3:git-{revision}'
    candidate = make_compose(old, image, source)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = ROOT / 'backups' / f'{stamp}-{revision}'
    backup.mkdir(parents=True, mode=0o700)
    write_json(backup / 'container.json', old)
    write_private(backup / 'projects.conf', REGISTRY.read_text(encoding='utf-8'))
    previous = RUNTIME.read_text(encoding='utf-8') if RUNTIME.exists() else None
    if previous is not None:
        write_private(backup / 'previous-compose.json', previous)
    candidate_path = backup / 'candidate-compose.json'
    write_json(candidate_path, candidate)
    compose(candidate_path, 'config', '--quiet')
    print(f'正在构建版本 {revision}，旧服务保持运行……', flush=True)
    run(['docker', 'build', '-f', str(source / 'Dockerfile.volcano-v3'), '-t', image, str(source)])
    # 固定旧镜像 ID，回退时不依赖可变 tag。
    rollback = json.loads(previous) if previous else None
    if rollback:
        rollback['services']['migpt']['image'] = old['Image']
    backup_name = f'{CONTAINER}-backup-{stamp}'
    renamed = False
    disconnected = {}
    stopped = False
    switched = False
    try:
        run(['docker', 'stop', '--time', '30', CONTAINER], capture=True)
        stopped = True
        run(['docker', 'cp', f'{CONTAINER}:/root/.migptgui', str(backup / 'data')], capture=True)
        if previous is None:
            run(['docker', 'rename', CONTAINER, backup_name], capture=True)
            renamed = True
            # 避免宿主机重启后保留的旧容器自动启动，与新服务争抢端口。
            run(['docker', 'update', '--restart=no', backup_name], capture=True)
            for name, endpoint in (old.get('NetworkSettings', {}).get('Networks') or {}).items():
                if name not in ('host', 'none'):
                    run(['docker', 'network', 'disconnect', name, backup_name], capture=True)
                    disconnected[name] = endpoint
        write_json(RUNTIME, candidate)
        switched = True
        compose(source / 'deploy/1panel/compose.yaml', 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '100', 'migpt')
        check_ready()
        register_project()
    except (Exception, KeyboardInterrupt):
        print('部署失败，正在恢复旧服务……', flush=True)
        try:
            if switched:
                compose(source / 'deploy/1panel/compose.yaml', 'rm', '--stop', '--force', 'migpt')
            if previous is None:
                if switched:
                    RUNTIME.unlink()
                if renamed:
                    reconnect_old(backup_name, disconnected)
                    run(['docker', 'rename', backup_name, CONTAINER], capture=True)
                    restart = old['HostConfig'].get('RestartPolicy') or {}
                    policy = restart.get('Name') or 'no'
                    if policy == 'on-failure' and restart.get('MaximumRetryCount'):
                        policy += ':' + str(restart['MaximumRetryCount'])
                    run(['docker', 'update', f'--restart={policy}', CONTAINER], capture=True)
                if stopped:
                    run(['docker', 'start', CONTAINER], capture=True)
                    if not inspect_container()['State'].get('Running'):
                        raise DeployError('旧容器未能恢复运行。')
            elif stopped:
                write_json(RUNTIME, rollback)
                compose(source / 'deploy/1panel/compose.yaml', 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '100', 'migpt')
                check_ready()
            write_private(REGISTRY, (backup / 'projects.conf').read_text(encoding='utf-8'))
        except Exception:
            raise DeployError(f'自动恢复未完成，请保留现场；部署配置与数据备份位于 {backup}。') from None
        raise DeployError(f'更新未成功，旧服务已恢复；备份位于 {backup}。') from None

    print(f'MiGPT 版本 {revision} 已部署，面板健康检查通过。')
    print(f'数据及部署配置备份：{backup}')
    if renamed:
        print(f'旧容器已保留（停止状态）：{backup_name}')
    print(compose(source / 'deploy/1panel/compose.yaml', 'ps', '--services', '--status', 'running').strip())
    safe_logs()
    print('请在 MiGPT 面板点击“启动”，再验证小爱及火山音色；更新器不会自动登录小米。')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4 or sys.argv[1] not in ('install', 'update') or sys.argv[3] != 'main':
            raise DeployError('用法：deploy.py install|update /opt/migpt-volcano-v3/source main')
        deploy(sys.argv[1], Path(sys.argv[2]))
    except KeyboardInterrupt:
        print('操作被中断，请检查容器状态和最近备份。', file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # 不输出 traceback、Docker inspect、启动参数或第三方错误正文。
        print(str(error) if isinstance(error, DeployError) else '部署失败，请检查依赖和最近备份；未输出可能包含凭证的内部错误。', file=sys.stderr)
        sys.exit(1)
