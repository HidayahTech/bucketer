// Entry point — mounts App into the #app div injected by build.mjs.
// No logic here: state, routing, and session lifecycle live in App.jsx.
import { render } from 'preact';
import { App } from './components/App.jsx';

render(<App />, document.getElementById('app'));
