import { summarize } from './_lib/iris.js';
import { route } from './_lib/http.js';

export default route((body) => summarize(body), { limit: 10 });
