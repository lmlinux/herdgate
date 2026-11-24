/**
 * Return the renderer's current grid size, or null before a renderer exists.
 * In that case callers should omit terminal.run's size and let the subsequent
 * attach provide the real dimensions instead of inventing another fixed size.
 */
export function terminalSize(view) {
  const cols = view?.terminal?.cols;
  const rows = view?.terminal?.rows;
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return null;
  return { cols, rows };
}

/**
 * Herdview forwards renderer resize events through attachment.resize. Wrap each
 * new attachment so a burst produces one pty resize after the pane is stable.
 */
export function debounceViewResize(view, delay = 200) {
  let timer = null;
  let pending = null;
  let wrappedAttachment = null;
  let sendResize = null;
  let wrappedResize = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  const restore = () => {
    cancel();
    if (wrappedAttachment && wrappedAttachment.resize === wrappedResize) {
      wrappedAttachment.resize = sendResize;
    }
    wrappedAttachment = null;
    sendResize = null;
    wrappedResize = null;
  };

  const off = view.on('status', ({ state }) => {
    if (state !== 'attached') {
      restore();
      return;
    }
    const attachment = view.attachment;
    if (!attachment || attachment === wrappedAttachment) return;
    restore();
    const send = attachment.resize;
    wrappedAttachment = attachment;
    sendResize = send;
    wrappedResize = (cols, rows) => {
      pending = { cols, rows };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const size = pending;
        pending = null;
        if (!size || view.destroyed || view.observe || !attachment.open || view.attachment !== attachment) return;
        send.call(attachment, size.cols, size.rows);
      }, delay);
      return attachment.open;
    };
    attachment.resize = wrappedResize;
  });

  return () => {
    off();
    restore();
  };
}
