// The stage's status line in a short form, for a bar with no room (app.css .status-short), instead of a word cut mid-way (DOM-free).

export const shortStatus = (msg: string): string =>
  msg.replace(/^(edge )?settled in /, '').replace(/^propagating… /, '').replace(/^solved instantly$/, 'solved').replace(/^switching… /, '').replace(/ \(\d+(\.\d+)? ms\)$/, '');
