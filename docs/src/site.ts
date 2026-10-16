// The site's base path without its trailing slash, and the page the header's
// Docs link opens.
export const base = import.meta.env.BASE_URL.replace(/\/$/, '');
export const docsHref = `${base}/getting-started/introduction/`;
