import { FormGroup, HTMLSelect, InputGroup } from '@blueprintjs/core'
import { type TTSConfig } from '../type.js'

type TTSVolcanoParams = Pick<TTSConfig, 'volcano'>

export function TTSVolcano(props: {
  value?: TTSVolcanoParams
  onChange: (value: TTSVolcanoParams) => void
}) {
  const volcano = props.value?.volcano
  function update(change: Partial<NonNullable<TTSConfig['volcano']>>) {
    props.onChange({
      ...props.value,
      volcano: {
        apiKey: '',
        resourceId: 'seed-icl-2.0',
        model: 'seed-tts-2.0-standard',
        ...volcano,
        ...change,
      },
    })
  }
  return (
    <div>
      <FormGroup
        label={'API Key'}
        inline
        helperText={
          '在新版豆包语音控制台的 API Key 页面获取；不再使用旧版 APP ID 和 Access Token。'
        }
      >
        <InputGroup
          required
          type="password"
          value={volcano?.apiKey || ''}
          onValueChange={(apiKey) => update({ apiKey })}
        />
      </FormGroup>
      <FormGroup label={'模型服务'} inline>
        <HTMLSelect
          value={volcano?.resourceId || 'seed-icl-2.0'}
          onChange={(event) =>
            update({
              resourceId: event.currentTarget.value as NonNullable<
                TTSConfig['volcano']
              >['resourceId'],
            })
          }
        >
          <option value="seed-icl-2.0">声音复刻 2.0（自定义音色）</option>
          <option value="seed-tts-2.0">语音合成 2.0（系统音色）</option>
        </HTMLSelect>
      </FormGroup>
      {(volcano?.resourceId || 'seed-icl-2.0') === 'seed-icl-2.0' && (
        <FormGroup label={'合成效果'} inline>
          <HTMLSelect
            value={volcano?.model || 'seed-tts-2.0-standard'}
            onChange={(event) =>
              update({
                model: event.currentTarget.value as NonNullable<
                  TTSConfig['volcano']
                >['model'],
              })
            }
          >
            <option value="seed-tts-2.0-standard">标准版</option>
            <option value="seed-tts-2.0-expressive">表现力增强版</option>
          </HTMLSelect>
        </FormGroup>
      )}
      <p>下方“音色”填写新版音色库中的完整音色 ID，复刻音色通常以 S_ 开头。</p>
    </div>
  )
}
