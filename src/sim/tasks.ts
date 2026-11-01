// Letting the browser run between two stretches of work: a message-channel task (no timer clamp, runs in a hidden tab
// too), so the page can paint and handle input while a long build goes on in slices.

export function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => {
      c.port1.close();
      resolve();
    };
    c.port2.postMessage(0);
  });
}
