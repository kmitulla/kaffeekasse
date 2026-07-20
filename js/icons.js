// Einheitliche Linien-Icons im iOS-Glass-Stil (statt Emojis).
// Alle Icons: 24er-Raster, runde Linien, Farbe erbt vom Element (currentColor).

const PATHS = {
  coffee: '<path d="M4.5 9h11.5v5.5a4.5 4.5 0 0 1-4.5 4.5H9a4.5 4.5 0 0 1-4.5-4.5V9z"/><path d="M16 10.2h1.4a2.65 2.65 0 0 1 0 5.3H16"/><path d="M8 6c-.7-.9.7-1.6 0-2.7M11.8 6c-.7-.9.7-1.6 0-2.7"/>',
  milk: '<path d="M9.5 3h5v3l2 3.5V19a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2V9.5L9.5 6V3z"/><path d="M7.5 13h9"/>',
  sugar: '<rect x="4" y="13" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13" width="6.5" height="6.5" rx="1.2"/><rect x="8.75" y="4.5" width="6.5" height="6.5" rx="1.2"/>',
  tea: '<path d="M4.5 10h11.5v4.5a4.5 4.5 0 0 1-4.5 4.5H9a4.5 4.5 0 0 1-4.5-4.5V10z"/><path d="M16 11.2h1.4a2.65 2.65 0 0 1 0 5.3H16"/><path d="M11 7.5c0-2.3 1.7-4 4.5-4.5 0 2.8-1.7 4.5-4.5 4.5z"/>',
  water: '<path d="M12 3.5c3.4 4.1 5.8 7 5.8 9.7a5.8 5.8 0 0 1-11.6 0c0-2.7 2.4-5.6 5.8-9.7z"/>',
  cake: '<path d="M4 19.5h16M5.5 19.5V14a6.5 6.5 0 0 1 13 0v5.5"/><path d="M5.5 14.8c1.6 1.2 2.7.1 4.3 0s2.7 1.2 4.4 0 2.7-.1 4.3 0"/><path d="M12 7.5V6"/><circle cx="12" cy="4.6" r="0.8"/>',
  box: '<path d="M4 8.2 12 4l8 4.2v7.6L12 20l-8-4.2V8.2z"/><path d="M4 8.2l8 4.1 8-4.1M12 12.3V20"/>',
  cart: '<path d="M3.5 4.5h2.2l2.1 10.6a1.5 1.5 0 0 0 1.5 1.2h7.4a1.5 1.5 0 0 0 1.5-1.2L20 8H7"/><circle cx="10" cy="19.7" r="1.3"/><circle cx="16.8" cy="19.7" r="1.3"/>',
  scale: '<path d="M12 4.5V19M8.5 19.5h7M5.5 7l13-2"/><path d="M5.5 7 3 13a2.8 2.8 0 0 0 5 0L5.5 7zM18.5 5 16 11a2.8 2.8 0 0 0 5 0l-2.5-6z"/>',
  banknote: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.2 9.8v.01M17.8 14.2v.01"/>',
  send: '<circle cx="12" cy="12" r="8.5"/><path d="M8.6 15.4l6.8-6.8M10.2 8.6h5.2v5.2"/>',
  receive: '<circle cx="12" cy="12" r="8.5"/><path d="M15.4 8.6l-6.8 6.8M13.8 15.4H8.6v-5.2"/>',
  person: '<circle cx="12" cy="8.2" r="3.4"/><path d="M5.5 19.5c.8-3.3 3.4-5.2 6.5-5.2s5.7 1.9 6.5 5.2"/>',
  personOut: '<circle cx="9.5" cy="8.2" r="3.2"/><path d="M3.5 19.5c.7-3.1 3.1-4.9 6-4.9 1.1 0 2.1.2 3 .7"/><path d="M15 12.5l3 3-3 3M21 15.5h-6"/>',
  people: '<circle cx="9" cy="9" r="3"/><path d="M15.5 11.5a3 3 0 1 0-2.2-5"/><path d="M3.5 19c.6-2.8 2.9-4.5 5.5-4.5s4.9 1.7 5.5 4.5M15.5 14.6c2 .4 3.6 1.9 4.1 4.4"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.4l2.7 2.7 5.3-5.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.3V12l3 2.1"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.7 2.7M13.3 9.7l2 2"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2.2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/><path d="M12 14v2"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.6v2.2M12 18.2v2.2M3.6 12h2.2M18.2 12h2.2M6.1 6.1l1.5 1.5M16.4 16.4l1.5 1.5M17.9 6.1l-1.5 1.5M7.6 16.4l-1.5 1.5"/>',
  download: '<path d="M12 4v10.5M8 11l4 4 4-4"/><path d="M5 19.5h14"/>',
  table: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M9.5 10v9M15 10v9"/>',
  swap: '<path d="M7 9.5h10l-3-3M17 14.5H7l3 3"/>',
  star: '<path d="M12 4.5l2.2 4.5 5 .8-3.6 3.5.8 5-4.4-2.4-4.4 2.4.8-5L4.8 9.8l5-.8L12 4.5z"/>',
  euro: '<circle cx="12" cy="12" r="8.5"/><path d="M15 9.3a3.9 3.9 0 1 0 0 5.4M8.3 11h4.5M8.3 13.2h4.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  qr: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><path d="M13.5 16.2h2.7M13.5 19.5h2.7M19.5 13.5v2.7M16.2 13.5h1M19.5 19.5h.01"/>'
};

export function icon(name, size = 22) {
  const p = PATHS[name] || PATHS.cart;
  return `<svg class="icn" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
