import { ask } from './_lib/iris.js';
import { route } from './_lib/http.js';

export default route((body) => ask(body), { limit: 20 });
