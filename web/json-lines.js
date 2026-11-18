export function createJsonLineParser(onLine) {
  const decoder = new TextDecoder();
  let pending = '';

  return (chunk) => {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      if (line.trim()) onLine(line);
      pending = pending.slice(newline + 1);
    }
    if (pending.trim()) {
      try {
        JSON.parse(pending);
        onLine(pending);
        pending = '';
      } catch {}
    }
  };
}
