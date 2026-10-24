import { perceive } from './_lib/iris.js';
import { route } from './_lib/http.js';

export default route((body) => perceive(body), { limit: 40 });
