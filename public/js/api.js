async function api(method, url, body) {
  const opts = {
    method,
    headers: {},
    credentials: 'same-origin'
  };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.data = data; // any extra fields the endpoint sent alongside the error (e.g. upcomingBookingsCount)
    throw err;
  }
  return data;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Accepts Australian mobile numbers in common written forms:
//   0412 345 678 / 0412345678 / +61 412 345 678 / 61412345678
// Spaces/dashes are ignored. Returns true for an empty string (field is optional).
function isValidAuMobile(phone) {
  const trimmed = (phone || '').trim();
  if (!trimmed) return true;
  const digitsAndPlus = trimmed.replace(/[\s-()]/g, '');
  return /^(?:0|\+?61)4\d{8}$/.test(digitsAndPlus);
}

// Shared lightbox for gallery thumbnails (photos and videos) - injects its
// own overlay into the page the first time it's used, so any page just needs
// to call openLightbox(url, mediaType, caption) from a click handler.
function openLightbox(url, mediaType, caption) {
  let overlay = document.getElementById('lightboxOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'lightboxOverlay';
    overlay.className = 'lightbox-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <button type="button" class="lightbox-close" aria-label="Close">&times;</button>
      <div class="lightbox-content"></div>
      <div class="lightbox-caption"></div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeLightbox(); });
    overlay.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeLightbox();
    });
  }
  const content = overlay.querySelector('.lightbox-content');
  content.innerHTML = mediaType === 'video'
    ? `<video src="${url}" controls autoplay playsinline></video>`
    : `<img src="${url}" alt="">`;
  overlay.querySelector('.lightbox-caption').textContent = caption || '';
  overlay.hidden = false;
}

function closeLightbox() {
  const overlay = document.getElementById('lightboxOverlay');
  if (!overlay) return;
  overlay.hidden = true;
  overlay.querySelector('.lightbox-content').innerHTML = ''; // stop any playing video
}

// Customer-facing pages call this once on load. If a stylist happens to be
// logged in on this browser, it adds a "My dashboard" link to the nav so
// they can get back to their admin screens. Otherwise it leaves an optional
// footer login link (by element id) visible, or does nothing if there isn't one -
// keeps "Hairdresser login" out of the way of ordinary customers.
async function initStylistLoginState(footerLinkId) {
  const footerLink = footerLinkId ? document.getElementById(footerLinkId) : null;
  try {
    await api('GET', '/api/auth/hairdresser/me');
    const nav = document.querySelector('nav.site-nav');
    if (nav && !nav.querySelector('[data-stylist-dashboard-link]')) {
      const a = document.createElement('a');
      a.href = '/dashboard.html';
      a.textContent = 'My dashboard';
      a.setAttribute('data-stylist-dashboard-link', '');
      nav.appendChild(a);
    }
    if (footerLink) footerLink.style.display = 'none';
  } catch (e) {
    // Not logged in as a stylist - leave things as they are.
  }
}
