// Keep a useful, accessible error if the device cannot create a WebGL2 context.
import('./main.js').catch((error) => {
  document.body.dataset.state = 'error';
  document.querySelector('#placeholder').textContent = 'La scène 3D n’a pas pu démarrer.';
  document.querySelector('#status').textContent = `Vérifiez que WebGL 2 est disponible, puis rechargez la page. ${error.message}`;
});
