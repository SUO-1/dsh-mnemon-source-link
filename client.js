window.__ModuleLoader__.load({
  id: 'dsh-mnemon-source-link',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const BASE = '/dsh-mnemon-source-link';
    const SOURCES = [
      { key: 'obsidian', label: 'Obsidian', rootLabel: 'Vault 根目录' },
      { key: 'loginote', label: 'LogiNote', rootLabel: 'Vault 根目录', extra: 'metadataPath' },
      { key: 'ledger', label: '任务台账', rootLabel: '工作区根目录', extra: 'file' },
    ];
    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '2px 0 6px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      label: {
        width: '112px',
        flex: 'none',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
      },
      input: {
        flex: '1',
        minWidth: 0,
        padding: '6px 9px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      title: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      btn: {
        alignSelf: 'flex-start',
        padding: '6px 14px',
        borderRadius: '6px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      msg: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      err: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
    };
    function Field(props) {
      return h(
        'div',
        { style: styles.row },
        h('span', { style: styles.label }, props.label),
        h('input', {
          style: styles.input,
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          onChange: (event) => props.onChange(event.target.value),
        }),
      );
    }
    function Check(props) {
      return h(
        'label',
        { style: { ...styles.row, cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h(
          'span',
          { style: { ...styles.label, width: 'auto', color: 'var(--dsw-alias-label-primary)' } },
          props.label,
        ),
      );
    }
    function Settings(props) {
      const [cfg, setCfg] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      const [err, setErr] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        fetch(BASE + '/config')
          .then((response) => response.json())
          .then((data) => {
            if (alive) setCfg(data && data.config ? data.config : {});
          })
          .catch(() => {
            if (alive) setErr('读取配置失败');
          });
        return () => {
          alive = false;
        };
      }, []);
      const view = props && props.view;
      if (cfg === null) return h('div', { style: styles.hint }, '正在读取配置…');
      const src = (key) => (cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {});
      const setSrc = (key, patch) => setCfg({ ...cfg, [key]: { ...src(key), ...patch } });
      if (view === 'summary') {
        const enabled = SOURCES.filter((source) => src(source.key).enabled)
          .map((source) => source.label)
          .join(' / ');
        return h('div', { style: styles.hint }, enabled ? '已启用：' + enabled : '未启用任何源');
      }
      const save = () => {
        setMsg('保存中…');
        setErr('');
        fetch(BASE + '/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cfg),
        })
          .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
          .then((result) => {
            if (result.ok) {
              setCfg(result.data.config);
              setMsg('已保存，插件会自动重启生效');
            } else {
              setErr((result.data && result.data.error) || '保存失败');
            }
          })
          .catch(() => setErr('保存请求失败'));
      };
      return h(
        'div',
        { style: styles.root },
        ...SOURCES.map((source) =>
          h(
            'div',
            { key: source.key, style: styles.card },
            h('div', { style: styles.title }, source.label),
            h('div', { style: styles.hint }, '只读扫描；启用后进入 Mnemon 统一召回，不写回任何文件。'),
            h(Check, {
              label: '启用',
              checked: src(source.key).enabled,
              onChange: (value) => setSrc(source.key, { enabled: value }),
            }),
            h(Field, {
              label: source.rootLabel,
              value: src(source.key).root,
              placeholder: '绝对路径，例如 D:/notes/vault',
              onChange: (value) => setSrc(source.key, { root: value }),
            }),
            source.key === 'loginote'
              ? h(Field, {
                  label: 'metadata.json',
                  value: src('loginote').metadataPath,
                  placeholder: '可留空（缺省 root/metadata.json）',
                  onChange: (value) => setSrc('loginote', { metadataPath: value }),
                })
              : null,
            source.key === 'ledger'
              ? h(Field, {
                  label: '台账文件名',
                  value: src('ledger').file,
                  placeholder: '交接.md',
                  onChange: (value) => setSrc('ledger', { file: value }),
                })
              : null,
          ),
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '扫描上限'),
          h(Field, {
            label: 'maxFiles',
            value: cfg.maxFiles === undefined ? 5000 : cfg.maxFiles,
            onChange: (value) => setCfg({ ...cfg, maxFiles: Number(value) || 0 }),
          }),
          h(Field, {
            label: 'maxFileBytes',
            value: cfg.maxFileBytes === undefined ? 1048576 : cfg.maxFileBytes,
            onChange: (value) => setCfg({ ...cfg, maxFileBytes: Number(value) || 0 }),
          }),
        ),
        h(
          'div',
          { style: styles.row },
          h('button', { style: styles.btn, onClick: save }, '保存'),
          msg ? h('span', { style: styles.msg }, msg) : null,
          err ? h('span', { style: styles.err }, err) : null,
        ),
      );
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-mnemon-source-link' },
            Settings,
          ),
        );
      },
    };
  },
});
