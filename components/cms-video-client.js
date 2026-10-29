/**
 * CmsVideo's browser script: starts each video unless the visitor prefers
 * reduced motion, and wires its pause/play button.
 *
 * A file of its own, emitted unprocessed by CmsVideo.astro's
 * `?url&no-inline` import and loaded with `<script src>`: a component
 * `<script>` this small is inlined into the page by Astro, which a site's
 * `script-src 'self'` CSP blocks, silently, in production only. Plain browser
 * JavaScript, as nothing compiles it. A module script loads once per URL, so
 * every CmsVideo on a page shares one run, which wires them all.
 */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

for (const wrapper of document.querySelectorAll('[data-cms-video]')) {
  const video = wrapper.querySelector('video');
  const toggle = wrapper.querySelector('[data-cms-video-toggle]');
  const icon = toggle?.querySelector('[data-cms-video-icon]');
  if (!video || !toggle || !icon) continue;
  const label = toggle.dataset.label || 'video';

  const show = () => {
    const playing = !video.paused;
    toggle.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${label}`);
    icon.textContent = playing ? '❚❚' : '▶';
  };
  video.addEventListener('play', show);
  video.addEventListener('pause', show);
  toggle.addEventListener('click', () => {
    if (video.paused) video.play().catch(show);
    else video.pause();
    // `paused` changes at once; its event only on a later task.
    show();
  });
  toggle.hidden = false;
  show();

  // A refused play (iOS Low Power Mode, a browser's autoplay policy) leaves
  // the poster and a Play button.
  if (!reducedMotion.matches) video.play().catch(show);
}
