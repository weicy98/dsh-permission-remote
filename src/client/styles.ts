const PLUGIN_ID = 'dsh-permission-remote'

const CSS = `
.dsh-ssh-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
}
.dsh-ssh-title {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.dsh-ssh-intro,
.dsh-ssh-note {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 22px;
}
.dsh-ssh-status {
  margin: 0;
  color: var(--dsw-alias-state-success-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-status[data-tone="warn"] {
  color: var(--dsw-alias-state-warn-label);
}
.dsh-ssh-card,
.dsh-ssh-host {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 14px 16px;
}
.dsh-ssh-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsh-ssh-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh-ssh-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}
.dsh-ssh-legend {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
}
.dsh-ssh-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-input,
.dsh-ssh-select {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  margin: 0;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-input:focus,
.dsh-ssh-select:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-host[data-editing="true"] {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-card[data-editing="true"] {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dsh-ssh-registry {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-ssh-registry > .dsh-ssh-field {
  flex: 1 1 240px;
}
.dsh-ssh-registry > .dsh-ssh-note {
  flex-basis: 100%;
}
/* Inline action inside a meta line: reads as a link, not a card button. */
.dsh-ssh-link {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  margin-left: 8px;
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.dsh-ssh-link:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.dsh-ssh-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-ssh-tab {
  appearance: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  padding: 6px 10px;
  /* A transparent underline reserves the space so switching tabs does not
     shift the text, and the negative margin lets the active line sit exactly
     on the container rule instead of floating above it. */
  border: 0;
  border-bottom: 2px solid transparent; /* after border:0, so it survives */
  border-radius: 0;
  margin-bottom: -1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dsh-ssh-tab:hover:not([data-active]) {
  color: var(--dsw-alias-label-primary);
}
/* An underline only. A filled pill read as a heavy control sitting on a page
   that is otherwise flat, and the theme's layer backgrounds are all one white
   in its light variant so a fill could not carry the state anyway. */
.dsh-ssh-tab[data-active] {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
  border-bottom-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-danger {
  color: var(--dsw-alias-state-warn-label);
  border-color: var(--dsw-alias-state-warn-label);
}
.dsh-ssh-danger-note {
  color: var(--dsw-alias-state-warn-label);
}
/* Title and its action read as one group on the left rather than the button
   floating at the far edge of a wide settings page. */
/* The add button only exists on the hosts tab, and it is taller than the title
   alone; a fixed row height keeps the content below from shifting when the tab
   changes. */
.dsh-ssh-header {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  min-height: 28px;
}
/* The add/edit form is a modal so it never sits between the host list and the
   page bottom. The backdrop pseudo-element dims the list without unmounting it. */
.dsh-ssh-dialog {
  margin: auto;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  max-width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  box-shadow: 0 24px 64px rgb(0 0 0 / 32%);
}
.dsh-ssh-dialog::backdrop {
  background: rgb(0 0 0 / 32%);
}
.dsh-ssh-dialog > .dsh-ssh-card {
  border: 0;
  border-radius: 0;
  background: transparent;
}
.dsh-ssh-dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dsh-ssh-close {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 20px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
}
.dsh-ssh-close:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-ssh-close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.dsh-ssh-hosts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh-ssh-host {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* The row holding the open picker: a brand edge ties the card to its host, so
   scrolling a long list cannot make it look attached to a neighbour. */
.dsh-ssh-host[data-browsing="true"] {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-host-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.dsh-ssh-host-identity {
  min-width: 0;
}
.dsh-ssh-banner {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 42ch;
}
.dsh-ssh-status-row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
/* Sits directly under the host row it belongs to, so the offer stays visible
   while the operator works on that host instead of at the page bottom. */
.dsh-ssh-trust {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-lg);
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-ssh-fingerprint {
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-3);
}
.dsh-ssh-workspaces {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-ssh-workspaces-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-ssh-disclosure {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 4px 2px 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.dsh-ssh-disclosure:hover {
  color: var(--dsw-alias-label-primary);
}
.dsh-ssh-chevron {
  display: inline-block;
  color: var(--dsw-alias-label-tertiary);
  transition: transform 0.15s var(--ds-ease-in-out, ease);
}
.dsh-ssh-chevron[data-open="true"] {
  transform: rotate(90deg);
}
.dsh-ssh-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}
/* In a tab the count is a quiet hint, not a pill; the filled variant was the
   heaviest thing in an otherwise flat tab row. */
.dsh-ssh-tab .dsh-ssh-count {
  min-width: 0;
  padding: 0;
  background: transparent;
  line-height: inherit;
}
.dsh-ssh-workspace-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.dsh-ssh-workspace {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-ssh-workspace:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ssh-workspace-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dsh-ssh-workspace-title,
.dsh-ssh-workspace-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ssh-workspace-title {
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-workspace-path {
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
}
.dsh-ssh-workspace-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}
.dsh-ssh-workspaces-empty {
  padding: 2px 2px 4px;
}
.dsh-ssh-toggle {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  line-height: 20px;
}
.dsh-ssh-toggle input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh-ssh-toggle .dsh-ssh-note {
  flex-basis: 100%;
  padding-left: 22px;
}
.dsh-ssh-deleted {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-ssh-host-name {
  min-width: 0;
  font-size: 14px;
  line-height: 22px;
}
.dsh-ssh-host-meta {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-row-actions,
.dsh-ssh-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dsh-ssh-button {
  height: 28px;
  margin: 0;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-ssh-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-ssh-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dsh-ssh-button[data-primary="true"] {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary-inverted, #fff);
}
.dsh-ssh-section-title {
  margin: 4px 0 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.dsh-ssh-manual {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-ssh-command {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.dsh-ssh-command-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-ssh-command code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-log {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
}
.dsh-ssh-dirs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 280px;
  overflow-y: auto;
}
/* The picker renders inside the host card, so it is a sunken section of that
   card rather than a second card: a nested card border read as an unrelated
   panel, and its own padding pushed the listing down. */
.dsh-ssh-browser {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  padding: 12px;
}
.dsh-ssh-browser-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.dsh-ssh-browser-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.dsh-ssh-browser-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.dsh-ssh-browser-host {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ssh-browser-filter {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-ssh-search {
  /* The shared input rule is width: 100%, which in this flex row would push the
     match count out of view; the filter row sizes the box instead. */
  width: auto;
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  font-size: 12px;
}
/* The count only appears while filtering, so it must not shift the box width. */
.dsh-ssh-filter-count {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.dsh-ssh-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-crumb-part {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.dsh-ssh-crumb {
  margin: 0;
  padding: 2px 4px;
  border: none;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
}
.dsh-ssh-crumb:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-ssh-crumb:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.dsh-ssh-crumb-sep {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-ssh-dir {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 28px;
  margin: 0;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dsh-ssh-dir:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* Keyboard highlight: an outline keeps it distinct from a hovered row, and it
   still applies while a listing loads and the rows are :disabled. */
.dsh-ssh-dir[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  outline: 1px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}
.dsh-ssh-dir:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
/* A loading listing still shows which row Enter would open, so the outline
   must not be dimmed away with the rest of the disabled row. */
.dsh-ssh-dir[data-active="true"]:disabled {
  opacity: 1;
}
.dsh-ssh-dir-icon {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-ssh-dir-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ssh-empty {
  padding: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-ssh-policy {
  width: auto;
  min-width: 92px;
  height: 28px;
  padding: 0 6px;
}
`

export function installStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
