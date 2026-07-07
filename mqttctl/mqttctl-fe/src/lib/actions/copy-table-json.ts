export type TableJsonPages = 'all' | 'none' | 'na' | readonly [number, number];

export interface TableJsonPayload {
  app?: string;
  section: string;
  table: string;
  pages?: TableJsonPages;
  columns: readonly string[];
  content: readonly Record<string, unknown>[];
}

const normalizePayload = (payload: TableJsonPayload) => ({
  app: payload.app ?? 'mqttctl',
  section: payload.section,
  table: payload.table,
  pages: payload.pages ?? 'na',
  columns: payload.columns,
  content: payload.content
});

const copyText = async (value: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  textArea.select();

  const copied = document.execCommand('copy');
  textArea.remove();

  if (!copied) throw new Error('Clipboard copy failed.');
};

export const copyTableAsJson = (node: HTMLElement, initialPayload: TableJsonPayload) => {
  let payload = initialPayload;
  let resetTimer: number | null = null;
  const toolbar = document.createElement('div');
  const button = document.createElement('button');

  const setButtonLabel = (label: string) => {
    button.textContent = label;
  };

  const resetButtonLabel = () => {
    setButtonLabel('Copy JSON');
    button.removeAttribute('data-state');
  };

  const scheduleReset = () => {
    if (resetTimer !== null) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(resetButtonLabel, 1500);
  };

  const handleCopy = async () => {
    try {
      await copyText(JSON.stringify(normalizePayload(payload)));
      button.setAttribute('data-state', 'copied');
      setButtonLabel('Copied');
    } catch {
      button.setAttribute('data-state', 'failed');
      setButtonLabel('Copy failed');
    } finally {
      scheduleReset();
    }
  };

  toolbar.className = 'table-copy-json-toolbar';
  button.className = 'table-copy-json-button button-ghost';
  button.type = 'button';
  button.title = 'Copy table as compact JSON';
  button.setAttribute('aria-label', 'Copy table as JSON');
  resetButtonLabel();
  button.addEventListener('click', handleCopy);
  toolbar.append(button);
  node.prepend(toolbar);

  return {
    update(nextPayload: TableJsonPayload) {
      payload = nextPayload;
    },
    destroy() {
      button.removeEventListener('click', handleCopy);
      toolbar.remove();
      if (resetTimer !== null) window.clearTimeout(resetTimer);
    }
  };
};
