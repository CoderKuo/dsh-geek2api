/**
 * The settings panel's stylesheet, built only from DSH design tokens so it
 * follows the host theme (light and dark) and matches the host's own settings
 * pages: settings cards, hairline-divided rows, 0.5px tags, layer-1 inputs.
 * Fallbacks cover hosts that predate the settings-card tokens.
 *
 * @module dsh-geek2api/client-style
 */

export const STYLE = `
.pkc{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.pkc-intro{margin:0;color:var(--dsw-alias-label-tertiary)}
.pkc-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,rgba(127,127,127,.3)));border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.pkc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.pkc-title{display:flex;align-items:center;gap:8px;margin:0;font-size:15px;font-weight:600;line-height:22px}
.pkc-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.pkc-warn{margin:0;color:var(--dsw-alias-state-warn-label,#dd8629);font-size:12px;line-height:18px}
.pkc-error{margin:0;color:var(--dsw-alias-state-error-primary,#ec1313);font-size:12px;line-height:18px}
.pkc-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px}
.pkc-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:12px;word-break:break-all}
.pkc-detail{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto}

.pkc-btn{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.pkc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pkc-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.pkc-btn:disabled{opacity:.4;cursor:not-allowed}
.pkc-btn[data-size=md]{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md,12px);font-size:13px}
.pkc-btn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.pkc-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.pkc-btn[data-variant=ghost]{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.pkc-btn[data-variant=danger]{border-color:transparent;color:var(--dsw-alias-state-error-primary)}
.pkc-btn[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

.pkc-input{box-sizing:border-box;flex:1 1 200px;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.pkc-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.pkc-input::placeholder{color:var(--dsw-alias-label-caption)}
.pkc-input:disabled{opacity:.5}
.pkc-link{color:var(--dsw-alias-state-business-primary);font-size:12px;text-decoration:none}
.pkc-link:hover{text-decoration:underline}
.pkc-textarea{display:block;width:100%;height:auto;min-height:96px;padding:8px 10px;line-height:1.6;resize:vertical;white-space:pre;overflow-x:auto}
.pkc-form{display:flex;flex-wrap:wrap;align-items:center;gap:8px}

.pkc-chip{flex:none;padding:0 8px;border-radius:999px;font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}
.pkc-chip[data-tone=success]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}
.pkc-chip[data-tone=danger]{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.pkc-chip[data-tone=info]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.pkc-chip[data-tone=neutral]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.pkc-tag{flex:none;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:18px;cursor:default}
.pkc-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.pkc-dot[data-tone=success]{background:var(--dsw-alias-state-success-primary)}
.pkc-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.pkc-dot[data-tone=danger]{background:var(--dsw-alias-state-error-primary)}

.pkc-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.pkc-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover)}
.pkc-stat-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.pkc-stat-value{font-size:20px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.pkc-list{display:flex;flex-direction:column}
.pkc-row{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.pkc-row:first-child{border-top:0;padding-top:2px}
.pkc-row-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px}
.pkc-row-name{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;font-weight:500}
.pkc-row-name>.pkc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pkc-actions{display:flex;flex-wrap:wrap;gap:4px}
.pkc-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.pkc-figures{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.pkc-figures b{margin-left:4px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.pkc-bar{height:4px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-interactive-bg-active)}
.pkc-bar>span{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-success-primary)}
.pkc-bar[data-level=warn]>span{background:var(--dsw-alias-state-warn-primary)}
.pkc-bar[data-level=low]>span{background:var(--dsw-alias-state-error-primary)}
.pkc-groups{display:flex;flex-wrap:wrap;align-items:center;gap:6px 6px}
.pkc-groups>.pkc-label{margin-right:2px}
.pkc-reach{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:12px;line-height:18px}
.pkc-reach>span{display:inline-flex;align-items:center;gap:4px;cursor:default}
.pkc-reach>span[data-state=ok]{color:var(--dsw-alias-state-success-primary)}
.pkc-reach>span[data-state=partial]{color:var(--dsw-alias-state-warn-label,#dd8629)}
.pkc-reach>span[data-state=no]{color:var(--dsw-alias-label-caption);text-decoration:line-through}
.pkc-add{display:flex;flex-direction:column;gap:8px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)}

.pkc-models{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0;padding:0;min-width:0;border:0}
.pkc-model{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover);cursor:pointer}
.pkc-model>input{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.pkc-model>span{display:flex;flex-direction:column;min-width:0;gap:2px}
.pkc-model b{font-size:13px;font-weight:500}
.pkc-models:disabled .pkc-model{opacity:.5;cursor:not-allowed}

.pkc-setting{display:grid;grid-template-columns:112px minmax(0,1fr);gap:6px 16px;align-items:start}
.pkc-setting>.pkc-label{padding-top:5px}
.pkc-setting>div{display:flex;flex-direction:column;gap:6px;min-width:0}
.pkc-seg{display:inline-flex;flex-wrap:wrap;align-self:flex-start;gap:2px;max-width:100%;padding:2px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover)}
.pkc-seg>button{height:28px;padding:0 12px;border:0;border-radius:calc(var(--dsw-radius-md,12px) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.pkc-seg>button:hover:not(:disabled):not([aria-checked=true]){color:var(--dsw-alias-label-primary)}
.pkc-seg>button[aria-checked=true]{background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:var(--dsw-shadow-lv1)}
.pkc-seg>button:disabled{cursor:not-allowed;opacity:.5}
.pkc-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font-size:13px}
.pkc-status>b{font-weight:600;font-variant-numeric:tabular-nums}
.pkc-callout{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-state-warn-tertiary)}
.pkc-callout[data-tone=info]{background:var(--dsw-alias-state-business-tertiary)}
.pkc-callout>.pkc-title{font-size:13px}
.pkc-split{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}

.pkc-advanced>summary{width:fit-content;padding:2px 4px;margin-left:-4px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;cursor:pointer}
.pkc-advanced>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pkc-advanced[open]>summary{margin-bottom:10px}
.pkc-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}

.pkc-composer{display:inline-flex;flex:0 0 auto;align-items:center;box-sizing:border-box;height:28px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}

@media (max-width:640px){
  .pkc-stats{grid-template-columns:1fr}
  .pkc-setting{grid-template-columns:1fr}
  .pkc-models{grid-template-columns:1fr}
  .pkc-setting>.pkc-label{padding-top:0}
}
`
