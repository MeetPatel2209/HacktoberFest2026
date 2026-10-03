import '@fontsource-variable/edu-qld-hand';
import './ui/styles.css';
import { createOllamaAdapter } from './llm/adapter.js';
import { mountApp } from './ui/app.js';

// ?model=llama3.1:8b in the URL tries another pulled model without a rebuild.
const model = new URLSearchParams(location.search).get('model') || undefined;

mountApp(document.querySelector('#app'), { llm: createOllamaAdapter({ model }) });
