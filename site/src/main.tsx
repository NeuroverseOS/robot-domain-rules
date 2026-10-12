import { render } from 'preact';
import './styles.css';
import { App, initialState } from './App';

initialState().then(initial => {
  render(<App initial={initial} />, document.getElementById('app')!);
});
