const NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/openapi.json', label: 'OpenAPI Spec' }
];

function isCurrentPath(href) {
  if (href === '/') {
    return window.location.pathname === '/' || window.location.pathname === '';
  }
  return window.location.pathname === href;
}

document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('#site-nav');
  if (!nav) {
    return;
  }

  const linkMarkup = NAV_LINKS.map((link) => {
    const active = isCurrentPath(link.href);
    const baseClasses = 'px-4 py-2 rounded-lg text-sm font-medium transition-colors';
    const activeClasses = 'bg-sky-500/10 text-sky-300 border border-sky-500/40 shadow-sm';
    const inactiveClasses = 'text-slate-300 hover:text-white hover:bg-slate-800/70 border border-transparent';

    return `
      <a href="${link.href}"
         class="${baseClasses} ${active ? activeClasses : inactiveClasses}">
        ${link.label}
      </a>
    `;
  }).join('');

  nav.innerHTML = `
    <div class="bg-slate-900/60 border-b border-slate-800">
      <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
        <div>
          <p class="text-sky-400 text-xs uppercase tracking-[0.2em]">gh-bot Monitoring</p>
          <h1 class="text-xl font-semibold text-white">Operations Dashboard</h1>
        </div>
        <div class="flex items-center gap-2">
          ${linkMarkup}
        </div>
      </div>
    </div>
  `;
});
