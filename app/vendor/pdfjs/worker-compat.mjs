/* Worker entry for the bundled pdf.js build.
 *
 * A module worker gets none of the page's globals, so the typed-array helpers
 * pdf.js expects have to be installed inside the worker too. pdf.js loads this
 * file through GlobalWorkerOptions.workerSrc; it then imports the unmodified
 * vendor build.
 */

import './compat.mjs';
import './pdf.worker.min.mjs';
