import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('migpt_deploy', Path(__file__).with_name('deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def container():
    return {
        'Id': 'a' * 64,
        'Image': 'sha256:previous-image',
        'State': {'Running': True, 'Health': {'Status': 'healthy'}},
        'Config': {
            'Hostname': 'a' * 12,
            'User': '', 'WorkingDir': '/app', 'Labels': {},
            'Env': ['DEBUG=', 'PASSWORD=p$a${x}'],
            'Entrypoint': ['node', 'apps/server/dist/index.js'],
            'Cmd': ['--port', '36592', '--user', 'admin', '--pwd', 'p$a${x}'],
            'ExposedPorts': {'36592/tcp': {}},
        },
        'HostConfig': {
            'AutoRemove': False, 'NetworkMode': 'bridge', 'Binds': ['/srv/migpt:/root/.migptgui:rw'],
            'PortBindings': {'36592/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '36593'}]},
            'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
            'ShmSize': 67108864, 'Runtime': 'runc', 'IpcMode': 'private',
            'CgroupnsMode': 'private', 'LogConfig': {'Type': 'json-file', 'Config': {}},
        },
        'Mounts': [{'Type': 'bind', 'Source': '/srv/migpt', 'Destination': '/root/.migptgui', 'RW': True, 'Mode': 'rw', 'Propagation': 'rprivate'}],
        'NetworkSettings': {'Networks': {'bridge': {'Aliases': None, 'IPAMConfig': None}}},
    }


class DeploymentTests(unittest.TestCase):
    def test_container_options_and_secrets_are_preserved(self):
        old = container()
        actual = deploy.make_compose(old, 'migpt:test', Path('/source'))
        service = actual['services']['migpt']
        self.assertEqual(service['ports'], [{'target': 36592, 'published': '36593', 'protocol': 'tcp', 'host_ip': '0.0.0.0'}])
        self.assertEqual(service['environment'], ['DEBUG=', 'PASSWORD=p$$a$${x}'])
        self.assertEqual(service['command'], ['--port', '36592', '--user', 'admin', '--pwd', 'p$$a$${x}'])
        self.assertEqual(service['entrypoint'], old['Config']['Entrypoint'])
        self.assertEqual(service['restart'], 'unless-stopped')
        self.assertEqual(service['volumes'][0]['source'], '/srv/migpt')
        self.assertEqual(service['network_mode'], 'bridge')
        self.assertIn('/ping', service['healthcheck']['test'][3])

    def test_named_volumes_and_static_network_are_external(self):
        old = container()
        old['Mounts'][0] = {'Type': 'volume', 'Name': 'original-volume', 'Destination': '/root/.migptgui', 'RW': True}
        old['HostConfig']['NetworkMode'] = 'original-network'
        old['NetworkSettings']['Networks'] = {'original-network': {'Aliases': ['speaker', old['Id'][:12]], 'IPAMConfig': {'IPv4Address': '172.20.0.9'}}}
        model = deploy.make_compose(old, 'migpt:test', Path('/source'))
        self.assertEqual(model['volumes']['data0'], {'external': True, 'name': 'original-volume'})
        self.assertEqual(model['networks']['network0'], {'external': True, 'name': 'original-network'})
        self.assertEqual(model['services']['migpt']['networks']['network0'], {'aliases': ['speaker'], 'ipv4_address': '172.20.0.9'})

    def test_unsupported_options_fail_before_deployment(self):
        old = container()
        old['HostConfig']['Devices'] = [{'PathOnHost': '/dev/example'}]
        with self.assertRaisesRegex(deploy.DeployError, 'HostConfig.Devices'):
            deploy.make_compose(old, 'migpt:test', Path('/source'))
        old = container()
        old['Mounts'] = []
        with self.assertRaisesRegex(deploy.DeployError, '持久挂载'):
            deploy.make_compose(old, 'migpt:test', Path('/source'))

    def test_registration_is_idempotent_and_preserves_other_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            registry = Path(directory) / 'projects.conf'
            original = '# comment\nminio|MinIO|/minio|master|update.sh|compose.yml|minio\nwork|Workbench|/work|master|update.sh|compose.yml|api\n'
            registry.write_text(original, encoding='utf-8')
            deploy.register_project(registry)
            deploy.register_project(registry)
            self.assertEqual(registry.read_text(encoding='utf-8'), original + deploy.ENTRY + '\n')

    def scenario(self, previous=False, failure=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        runtime = root / 'runtime/compose.json'
        registry = root / 'projects.conf'
        registry.write_text('minio|existing\nwork|existing\n', encoding='utf-8')
        old = container()
        if previous:
            old['Config']['Labels'] = {'com.docker.compose.project': deploy.PROJECT, 'com.docker.compose.service': 'migpt'}
            deploy.write_json(runtime, deploy.make_compose(old, 'migpt:old-tag', root / 'source'))
        operations = []
        state = {'running': True, 'ready_calls': 0}

        def fake_run(args, capture=False):
            operations.append(args)
            if args[0] == 'git':
                return 'abc123\n'
            if args[1] == 'build' and failure == 'build':
                raise deploy.DeployError('build failed')
            if args[1] == 'stop':
                state['running'] = False
            if args[1] == 'start':
                state['running'] = True
            if args[1] == 'cp' and failure == 'backup':
                raise deploy.DeployError('backup failed')
            return ''

        def fake_compose(file, *args):
            operations.append(['compose', str(file), *args])
            if args[0] == 'up':
                state['running'] = True
            return ''

        def ready():
            state['ready_calls'] += 1
            if failure == 'health' and state['ready_calls'] == 1:
                raise deploy.DeployError('health failed')

        with patch.multiple(deploy, ROOT=root, RUNTIME=runtime, REGISTRY=registry), \
                patch.object(deploy, 'inspect_container', return_value=copy.deepcopy(old)), \
                patch.object(deploy, 'run', side_effect=fake_run), \
                patch.object(deploy, 'compose', side_effect=fake_compose), \
                patch.object(deploy, 'check_ready', side_effect=ready), \
                patch.object(deploy, 'safe_logs'), redirect_stdout(io.StringIO()):
            if failure:
                with self.assertRaises(deploy.DeployError):
                    deploy.deploy_locked('update' if previous else 'install', root / 'source')
            else:
                deploy.deploy_locked('update' if previous else 'install', root / 'source')
        return operations, state, runtime, registry

    def test_build_failure_does_not_stop_container(self):
        operations, state, _, registry = self.scenario(failure='build')
        self.assertFalse(any(item[:2] == ['docker', 'stop'] for item in operations))
        self.assertTrue(state['running'])
        self.assertNotIn('migpt|', registry.read_text())

    def test_migration_keeps_old_container_and_registers_after_health(self):
        operations, state, runtime, registry = self.scenario()
        self.assertTrue(state['running'])
        self.assertTrue(runtime.exists())
        self.assertTrue(any(item[:2] == ['docker', 'rename'] for item in operations))
        self.assertTrue(any(item[:3] == ['docker', 'update', '--restart=no'] for item in operations))
        self.assertTrue(any(item[:3] == ['docker', 'network', 'disconnect'] for item in operations))
        self.assertTrue(registry.read_text().endswith(deploy.ENTRY + '\n'))

    def test_migration_health_failure_restores_independent_container(self):
        operations, state, runtime, registry = self.scenario(failure='health')
        self.assertTrue(state['running'])
        self.assertFalse(runtime.exists())
        self.assertTrue(any(item[:3] == ['docker', 'network', 'connect'] for item in operations))
        self.assertTrue(any(item[:2] == ['docker', 'start'] for item in operations))
        self.assertTrue(any(item[:3] == ['docker', 'update', '--restart=unless-stopped'] for item in operations))
        self.assertEqual(registry.read_text(), 'minio|existing\nwork|existing\n')

    def test_update_health_failure_uses_immutable_previous_image(self):
        _, state, runtime, registry = self.scenario(previous=True, failure='health')
        self.assertTrue(state['running'])
        self.assertEqual(json.loads(runtime.read_text())['services']['migpt']['image'], 'sha256:previous-image')
        self.assertNotIn('migpt|', registry.read_text())

    def test_backup_failure_restarts_old_container_without_replacement(self):
        operations, state, _, _ = self.scenario(failure='backup')
        self.assertTrue(state['running'])
        self.assertFalse(any(item[:2] == ['docker', 'rename'] for item in operations))
        self.assertFalse(any(item[0] == 'compose' and item[2] == 'up' for item in operations))

    def test_repeat_install_only_registers_existing_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / 'compose.json'
            runtime.write_text('{}')
            registry = root / 'projects.conf'
            registry.write_text('minio|existing\n')
            old = container()
            old['Config']['Labels'] = {'com.docker.compose.project': deploy.PROJECT, 'com.docker.compose.service': 'migpt'}
            with patch.multiple(deploy, ROOT=root, RUNTIME=runtime, REGISTRY=registry), \
                    patch.object(deploy, 'inspect_container', return_value=old), \
                    patch.object(deploy, 'check_ready'), patch.object(deploy, 'run') as execute, \
                    redirect_stdout(io.StringIO()):
                deploy.deploy_locked('install', root)
                deploy.deploy_locked('install', root)
            execute.assert_not_called()
            self.assertEqual(registry.read_text().count(deploy.ENTRY), 1)


if __name__ == '__main__':
    unittest.main()
