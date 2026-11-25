window.__ModuleLoader__.load({
  id: 'dsh-mnemon-source-link',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PKG = 'dsh-mnemon-source-link';
    // The Host settings namespace that carries this entry's configuration is the
    // loader entry id, which the profile addresses as `mnemon-source-link`. Fall
    // back to the package name for builds where the row id equals the package.
    const ENTRY_CANDIDATES = ['mnemon-source-link', 'include:mnemon-source-link', PKG];
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
      btnDisabled: { alignSelf: 'flex-start', padding: '6px 14px', borderRadius: '6px', cursor: 'not-allowed', opacity: 0.55, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', fontFamily: 'inherit' },
      msg: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      err: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
      note: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
    };
    function Field(props) {
      const disabled = Boolean(props.disabled);
      return h(
        'div',
        { style: styles.row },
        h('span', { style: styles.label }, props.label),
        h('input', {
          style: disabled ? Object.assign({}, styles.input, { opacity: 0.6 }) : styles.input,
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          placeholder: props.placeholder || '',
          disabled: disabled,
          onChange: (event) => props.onChange(event.target.value),
        }),
      );
    }
    function Check(props) {
      const disabled = Boolean(props.disabled);
      return h(
        'label',
        { style: { ...styles.row, cursor: disabled ? 'not-allowed' : 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          disabled: disabled,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h(
          'span',
          { style: { ...styles.label, width: 'auto', color: 'var(--dsw-alias-label-primary)' } },
          props.label,
        ),
      );
    }
    function clone(value) {
      try {
        return JSON.parse(JSON.stringify(value === undefined || value === null ? {} : value));
      } catch (_error) {
        return {};
      }
    }
    // Subscribe to one Host configuration form (from the shared `configForms`
    // service) and keep its latest snapshot. The snapshot carries
    // `status: 'loading' | 'ready' | 'unavailable'`, the accepted value, the
    // write revision fence, and whether the Host document accepts writes.
    function useFormSnapshot(form) {
      const [snap, setSnap] = React.useState(function () {
        return form.getSnapshot();
      });
      React.useEffect(
        function () {
          setSnap(form.getSnapshot());
          return form.subscribe(function () {
            setSnap(form.getSnapshot());
          });
        },
        [form],
      );
      return snap;
    }
    // Flatten a draft configuration into ordered Host path operations. Only the
    // fields this form edits are written; everything else (e.g. `excludes`) is
    // left untouched so the Host keeps it as-is.
    function buildOps(draft) {
      const ops = [];
      const fields = {
        obsidian: ['enabled', 'root'],
        loginote: ['enabled', 'root', 'metadataPath'],
        ledger: ['enabled', 'root', 'file'],
      };
      Object.keys(fields).forEach(function (key) {
        const section = draft[key] && typeof draft[key] === 'object' ? draft[key] : {};
        fields[key].forEach(function (name) {
          if (section[name] !== undefined && section[name] !== null) {
            ops.push({ op: 'set', path: [key, name], value: section[name] });
          }
        });
      });
      ['maxFiles', 'maxFileBytes'].forEach(function (name) {
        if (draft[name] !== undefined && draft[name] !== null) {
          ops.push({ op: 'set', path: [name], value: draft[name] });
        }
      });
      return ops;
    }
    function Settings(props) {
      const form = props.form;
      const snap = useFormSnapshot(form);
      const [draft, setDraft] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      const [err, setErr] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      // Re-seed the editable draft whenever the Host publishes a new accepted
      // value/revision (first load and after any successful save).
      React.useEffect(
        function () {
          if (snap.status === 'ready') {
            setDraft(clone(snap.value));
            setErr('');
          }
        },
        [snap.status, snap.revision],
      );

      if (snap.status === 'loading') {
        return h('div', { style: styles.hint }, '正在读取配置…');
      }
      if (snap.status === 'unavailable') {
        return h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '配置不可用'),
          h(
            'div',
            { style: styles.err },
            '宿主未提供本插件的配置命名空间（entryId=' + String(props.entryId) + '）。请确认插件已启用，或重启 DSH 后重试。',
          ),
          h('div', { style: styles.note }, '仍可直接编辑 profile 的 cordis.patch.yml 修改配置。'),
        );
      }

      const cfg = draft || snap.value || {};
      const ro = !snap.writable;
      const src = (key) => (cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {});
      const setSrc = (key, patch) => setDraft(Object.assign({}, cfg, { [key]: Object.assign({}, src(key), patch) }));
      if (props.view === 'summary') {
        const enabled = SOURCES.filter((source) => src(source.key).enabled)
          .map((source) => source.label)
          .join(' / ');
        return h('div', { style: styles.hint }, enabled ? '已启用：' + enabled : '未启用任何源');
      }
      const save = () => {
        if (ro || busy) return;
        setBusy(true);
        setMsg('保存中…');
        setErr('');
        Promise.resolve()
          .then(() => form.mutate(buildOps(cfg), snap.revision))
          .then((ok) => {
            setBusy(false);
            if (ok) {
              setMsg('已保存，插件会自动重启生效');
            } else {
              setErr('保存被拒绝：可能为只读，或有字段未通过校验');
            }
          })
          .catch((error) => {
            setBusy(false);
            setErr('保存失败：' + (error && error.message ? error.message : String(error)));
          });
      };
      return h(
        'div',
        { style: styles.root },
        ro
          ? h('div', { style: styles.note }, '当前为只读：Host 文档不接受写入，以下字段仅供查看。')
          : null,
        ...SOURCES.map((source) =>
          h(
            'div',
            { key: source.key, style: styles.card },
            h('div', { style: styles.title }, source.label),
            h('div', { style: styles.hint }, '只读扫描；启用后进入 Mnemon 统一召回，不写回任何文件。'),
            h(Check, {
              label: '启用',
              checked: src(source.key).enabled,
              disabled: ro,
              onChange: (value) => setSrc(source.key, { enabled: value }),
            }),
            h(Field, {
              label: source.rootLabel,
              value: src(source.key).root,
              placeholder: '绝对路径，例如 D:/notes/vault',
              disabled: ro,
              onChange: (value) => setSrc(source.key, { root: value }),
            }),
            source.key === 'loginote'
              ? h(Field, {
                  label: 'metadata.json',
                  value: src('loginote').metadataPath,
                  placeholder: '可留空（缺省 root/metadata.json）',
                  disabled: ro,
                  onChange: (value) => setSrc('loginote', { metadataPath: value }),
                })
              : null,
            source.key === 'ledger'
              ? h(Field, {
                  label: '台账文件名',
                  value: src('ledger').file,
                  placeholder: '交接.md',
                  disabled: ro,
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
            disabled: ro,
            onChange: (value) => setDraft(Object.assign({}, cfg, { maxFiles: Number(value) || 0 })),
          }),
          h(Field, {
            label: 'maxFileBytes',
            value: cfg.maxFileBytes === undefined ? 1048576 : cfg.maxFileBytes,
            disabled: ro,
            onChange: (value) => setDraft(Object.assign({}, cfg, { maxFileBytes: Number(value) || 0 })),
          }),
        ),
        h(
          'div',
          { style: styles.row },
          h('button', { style: ro || busy ? styles.btnDisabled : styles.btn, disabled: ro || busy, onClick: save }, busy ? '保存中…' : '保存'),
          msg ? h('span', { style: styles.msg }, msg) : null,
          err ? h('span', { style: styles.err }, err) : null,
        ),
      );
    }
    // Resolve which served settings namespace carries this entry's configuration.
    // The Host describe mirror lists every namespace it serves; pick the first of
    // our candidate ids that it exposes. Returns undefined until the mirror loads
    // (or when none of our ids is served).
    function inspectEntry(configForms) {
      let view;
      try {
        view = configForms.describe().getSnapshot().view;
      } catch (_error) {
        view = undefined;
      }
      if (view === undefined) {
        return { loaded: false, entryId: undefined, served: [] };
      }
      const served = (view.namespaces || []).map((entry) => entry && entry.ns).filter(Boolean);
      const have = new Set(served);
      return { loaded: true, entryId: ENTRY_CANDIDATES.find((id) => have.has(id)), served: served };
    }
    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: PKG },
            function BundleConfigSlot(slotProps) {
              const [state, setState] = React.useState(function () {
                return inspectEntry(ctx.configForms);
              });
              React.useEffect(function () {
                let describe;
                try {
                  describe = ctx.configForms.describe();
                } catch (_error) {
                  return undefined;
                }
                const sync = function () {
                  setState(inspectEntry(ctx.configForms));
                };
                sync();
                return describe.subscribe(sync);
              }, []);
              if (!state.loaded) {
                return h('div', { style: styles.hint }, '正在连接配置服务…');
              }
              if (state.entryId === undefined) {
                return h(
                  'div',
                  { style: styles.card },
                  h('div', { style: styles.title }, '配置不可用'),
                  h(
                    'div',
                    { style: styles.err },
                    '宿主未提供本插件的配置命名空间。期望其一：' + ENTRY_CANDIDATES.join(' / '),
                  ),
                  h('div', { style: styles.note }, '宿主当前提供的命名空间：' + (state.served.length ? state.served.join(', ') : '（无）')),
                  h('div', { style: styles.note }, '可先重启 DSH 使其暴露本插件配置，或直接编辑 profile 的 cordis.patch.yml。'),
                );
              }
              const form = ctx.configForms.get(state.entryId);
              return h(Settings, Object.assign({}, slotProps, { form: form, entryId: state.entryId }));
            },
          ),
        );
      },
    };
  },
});
