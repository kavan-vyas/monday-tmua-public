// The simulator's chrome stylesheet (web/public/sim/sim.css), an original sheet that
// styles the driver markup in this folder. Colour schemes swap its tokens through
// <html data-scheme="…">.
export const SCHEMES = [
  { id: 'Default', label: 'Color Scheme' },
  { id: 'BlackonLightYellow', label: 'Black on Light Yellow' },
  { id: 'BlackonSalmon', label: 'Black on Salmon' },
  { id: 'BlackonWhite', label: 'Black on White' },
  { id: 'BlackonYellow', label: 'Black on Yellow' },
];

let loaded = false;
export function loadDriverCss() {
  if (loaded) return;
  loaded = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/sim/sim.css';
  document.head.appendChild(l);
}

export function applyScheme(id) {
  document.documentElement.dataset.scheme = id || 'Default';
}
