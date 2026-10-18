// Applies a saved theme before first paint to avoid a flash. Kept tiny and
// separate because the CSP forbids inline scripts.
try {
  var saved = localStorage.getItem('tastefit-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch (e) {
  /* storage unavailable: follow the system theme */
}
