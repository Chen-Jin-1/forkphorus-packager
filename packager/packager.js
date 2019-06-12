// @ts-check

(function() {
  'use strict';

  // @ts-ignore
  const SBDL = window.SBDL;
  // @ts-ignore
  const JSZip = window.JSZip;

  /**
   * A progress bar
   * @typedef {Object} ProgressBar
   * @property {number} finished
   * @property {number} total
   * @property {function():void} finish
   * @property {function(number):void} percent
   */

   /**
   * The result of getting a project
   * @typedef {Object} ProjectResult
   * @property {string} url
   * @property {string} type
   */

  /**
   * Options
   * @typedef {Object} Options
   * @property {string} loadingText
   * @property {string} postLoadScript
   * @property {string} customStyle
   */

  const sectionLoading = document.getElementById('loading-section');
  const sectionProjectFile = document.getElementById('project-file-section');
  const sectionProjectId = document.getElementById('project-id-section');
  const packageHtmlButton = document.getElementById('package-html');
  const inputProjectId = /** @type {HTMLInputElement} */ (document.getElementById('project-id-input'));
  const inputProjectFile = /** @type {HTMLInputElement} */ (document.getElementById('project-file-input'));
  const inputLoadingText = /** @type {HTMLInputElement} */ (document.getElementById('loading-text-input'));
  const inputPostLoadScript = /** @type {HTMLInputElement} */ (document.getElementById('post-load-script-input'));
  const inputCustomStyle = /** @type {HTMLInputElement} */ (document.getElementById('custom-style-input'));

  /**
   * API route to fetch a project, replace $id with project ID.
   */
  const PROJECT_API = 'https://projects.scratch.mit.edu/$id';

  /**
   * File cache
   */
  const fileCache = {
    css: '',
    js: '',
  };

  // Replace fetch so we can observe progress of things
  const nativeFetch = window.fetch;
  window.fetch = function fetch(url, options) {
    currentProgressBar.total++;
    return nativeFetch(url, options)
      .then((res) => {
        currentProgressBar.finished++
        return res;
      });
  };

  /**
   * @type {ProgressBar}
   */
  var currentProgressBar = null;

  /**
   * Create a new progress bar
   * @param {string} text The name of the progress bar
   * @returns {ProgressBar}
   */
  function createProgressBar(text) {
    const div = document.createElement('div');
    const progressEl = document.createElement('progress');
    progressEl.value = 0;
    const label = document.createElement('i');
    label.style.paddingLeft = '5px';
    label.textContent = text;
    div.appendChild(progressEl);
    div.appendChild(label);
    sectionLoading.appendChild(div);

    var finished = 0;
    var total = 0;
    var updateProgress = () => {
      if (total === 0) {
        progressEl.value = 0;
      } else {
        progressEl.value = finished / total;
      }
    };

    /**
     * @type {ProgressBar}
     */
    const progressBar = {
      set total(_total) {
        total = _total;
        updateProgress();
      },
      set finished(_finished) {
        finished = _finished;
        updateProgress();
      },
      get total() { return total; },
      get finished() { return finished; },
      finish() {
        total = finished = 1;
        updateProgress();
      },
      percent(percent) {
        total = 1;
        finished = percent;
        updateProgress();
      },
    };

    currentProgressBar = progressBar;
    return progressBar;
  }
  /**
   * Remove all progress bars
   */
  function removeProgressBars() {
    currentProgressBar = null;
    while (sectionLoading.firstChild) {
      sectionLoading.removeChild(sectionLoading.firstChild);
    }
  }

  /**
   * Fetch a text file
   * @param {string} path
   * @returns {Promise<string>}
   */
  function getFile(path) {
    return fetch(path).then((r) => r.text());
  }

  /**
   * Inlines URLs in a source string with a data: URI
   * @param {string} source
   * @param {string[]} urls
   * @returns {Promise<string>}
   */
  function inlineURLs(source, urls) {
    const promises = urls.map((i) => fetch('../' + i)
      .then((res) => res.blob())
      .then((blob) => readBlob(blob))
      .then((url) => void (source = source.replace(i, url)))
    );
    return Promise.all(promises).then(_ => source);
  }

  /**
   * Loads forkphorus and its dependencies.
   * @return {Promise<void>}
   */
  function loadSources() {
    const progressBar = createProgressBar('Loading forkphorus');
    const promises = [];
    if (!fileCache.js) {
      promises.push(Promise.all([
        getFile('../lib/jszip.min.js'),
        getFile('../lib/fontfaceobserver.standalone.js'),
        getFile('../lib/stackblur.min.js'),
        getFile('../lib/rgbcolor.js'),
        getFile('../lib/canvg.min.js'),
        getFile('../phosphorus.dist.js'),
      ]).then((sources) => {
        return inlineURLs(sources.join('\n'), [
          'fonts/Knewave-Regular.woff',
          'fonts/Handlee-Regular.woff',
          'fonts/Grand9K-Pixel.ttf',
          'fonts/Griffy-Regular.woff',
          'fonts/SourceSerifPro-Regular.woff',
          'fonts/NotoSans-Regular.woff',
          'fonts/Scratch.ttf',
        ]).then((source) => {
          fileCache.js = source;
        });
      }));
    }
    if (!fileCache.css) {
      promises.push(getFile('../phosphorus.css').then((text) => {
        return inlineURLs(text, [
          'fonts/DonegalOne-Regular.woff',
          'fonts/GloriaHallelujah.woff',
          'fonts/MysteryQuest-Regular.woff',
          'fonts/PermanentMarker-Regular.woff',
          'fonts/Scratch.ttf',
        ]).then((source) => {
          fileCache.css = source;
        });
      }));
    }
    if (promises.length === 0) {
      progressBar.finish();
      return Promise.resolve();
    }
    return Promise.all(promises).then(_ => undefined);
  }

  /**
   * Determines the project type of a project from scratch.mit.edu
   * @param {string} id The project ID
   * @returns {Promise<'sb2'|'sb3'>}
   * @throws if the project type cannot be determined
   */
  function getProjectTypeById(id) {
    createProgressBar('Determining project type');
    return fetch(PROJECT_API.replace('$id', id))
      .then((r) => r.json())
      .then((data) => {
        currentProgressBar.finish();
        if ('targets' in data) return 'sb3';
        if ('objName' in data) return 'sb2';
        throw new Error('unknown project type');
      });
  }

  /**
   * Converts a Blob to a data: URL
   * @param {Blob|File} blob
   * @param {(progress: number) => void} [progressCallback]
   * @returns {Promise<string>}
   */
  function readBlob(blob, progressCallback) {
    return new Promise((resolve, reject) => {
      const fileReader = new FileReader();
      fileReader.onload = () => {
        if (progressCallback) {
          progressCallback(1);
        }
        resolve(/** @type {string} */ (fileReader.result));
      };
      if (progressCallback) {
        fileReader.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const progress = e.loaded / e.total;
          if (Number.isNaN(progress)) {
            progressCallback(0);
          } else {
            progressCallback(progress);
          }
        };
      };
      fileReader.onerror = (e) => {
        reject('Error reading file');
      };
      fileReader.readAsDataURL(blob);
    })
  }

  /**
   * @param {any} files Files from an SBDL result
   * @returns {Blob} A Blob representation of the zip
   */
  function createArchive(files) {
    const progressBar = createProgressBar('Creating archive');
    const zip = new JSZip();
    for (const file of files) {
      const path = file.path;
      const data = file.data;
      zip.file(path, data);
    }
    return zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
    }, function updateCallback(/** @type {any} */ metadata) {
      progressBar.percent(metadata.percent);
    });
  }

  /**
   * Fetches a project, and converts its zip archive to a data: URL
   * @param {string} id The project ID
   * @returns {Promise<ProjectResult>}
   */
  function getProjectById(id) {
    var type = '';
    return getProjectTypeById(id)
      .then((t) => {
        type = t;
        createProgressBar('Loading project');
        return SBDL.loadProject(id, type);
      })
      .then((result) => {
        // all types we support should be of 'zip'
        if (result.type !== 'zip') {
          throw new Error('unknown result type: ' + result.type);
        }
        return createArchive(result.files);
      })
      .then((blob) => {
        const progressBar = createProgressBar('Reading archive');
        return readBlob(blob, (progress) => progressBar.percent(progress));
      })
      .then((url) => {
        return {
          url: url,
          type: type,
        };
      });
  }

  /**
   * Reads a file, and converts it to a data: URL
   * @param {File} file The file
   * @returns {Promise<ProjectResult>}
   */
  function getProjectByFile(file) {
    var type;
    const projectTypeProgressBar = createProgressBar('Determining project type');
    return JSZip.loadAsync(file)
      .then((zip) => {
        return zip.file('project.json').async('string');
      })
      .then((json) => {
        json = JSON.parse(json);
        if ('objName' in json) {
          type = 'sb2';
        } else if ('targets' in json) {
          type = 'sb3';
        } else {
          throw new Error('unknown project type (invalid project?)');
        }
        projectTypeProgressBar.finish();
        const progressBar = createProgressBar('Reading project');
        return readBlob(file, (progress) => progressBar.percent(progress));
      })
      .then((/** @type {string} */ url) => {
        return {
          type,
          url,
        };
      });
  }

  /**
   * Creates the HTML page for a project
   * @param {ProjectResult} result The result of loading the project
   * @returns {string}
   */
  function getProjectHTML(result) {
    const options = getOptions();
    return `<!DOCTYPE html>
  <html>

  <!-- https://forkphorus.github.io/ -->

  <head>
    <style>
      ${fileCache.css}
    </style>
    <style>
      body, html {
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: #000;
      }
      #root, #splash, #error {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }
      #splash, #error {
        background: #000;
        display: table;
        color: #fff;
        cursor: default;
      }
      #error {
        display: none;
      }
      #splash > div,
      #error > div {
        display: table-cell;
        height: 100%;
        text-align: center;
        vertical-align: middle;
      }

      #progress {
        width: 80%;
        height: 16px;
        border: 1px solid #fff;
        margin: 0 auto;
      }
      #progress-bar {
        background: #fff;
        width: 10%;
        height: 100%;
      }
      h1 {
        font: 300 52px sans-serif;
        margin: 0 0 16px;
      }
      p {
        font: 300 24px/1.5 sans-serif;
        margin: 0;
        color: rgba(255, 255, 255, .6);
      }
      ${options.customStyle}
    </style>
  </head>

  <body>
    <div id="root"></div>
    <div id="splash">
      <div>
        ${ options.loadingText ? `<h1>${options.loadingText}</h1>` : '' }
        <div id="progress"><div id="progress-bar"></div></div>
      </div>
    </div>
    <div id="error">
      <div>
        <h1>Internal Error</h1>
        <p>An error has occurred. <a id="error-bug-link" href="https://github.com/forkphorus/forkphorus/issues/new" target="_blank">Click here</a> to file a bug report.</p>
      </div>
    </div>

    <!-- forkphrous, and it's dependencies -->
    <script>
      ${fileCache.js}
    </script>

    <!-- special hooks for NW.js -->
    <script>
    (function() {
      if (typeof nw !== 'undefined') {
        // open links in the browser
        var win = nw.Window.get();
        win.on('new-win-policy', (frame, url, policy) => {
          policy.ignore();
          nw.Shell.openExternal(url);
        });
        // fix the size of the window made by NW.js
        var package = nw.require('package.json');
        if (package.window && package.window.height && package.window.width) {
          win.resizeBy(package.window.width - window.innerWidth, package.window.height - window.innerHeight);
        }
      }
    })();
    </script>

    <!-- project data & player -->
    <script>
    (function() {

      // ---
      var type = '${result.type}';
      var project = '${result.url}';
      // ---

      var root = document.getElementById('root');
      var progressBar = document.getElementById('progress-bar');
      var splash = document.getElementById('splash');
      var error = document.getElementById('error');
      var bugLink = document.getElementById('error-bug-link');

      var stage;

      var totalTasks = 0;
      var completedTasks = 0;
      P.IO.progressHooks.new = function() {
        totalTasks++;
        progressBar.style.width = (10 + completedTasks / totalTasks * 90) + '%';
      };
      P.IO.progressHooks.end = function() {
        completedTasks++;
        progressBar.style.width = (10 + completedTasks / totalTasks * 90) + '%';
      };

      function showError(e) {
        error.style.display = 'table';
        bugLink.href = createBugLink('Describe what you were doing to cause this error:', '\`\`\`\\n' + P.utils.stringifyError(e) + '\\n\`\`\`');
        console.error(e.stack);
      }

      function createBugLink(before, after) {
        var title = 'Error in packaged project ' + document.title;
        var baseBody = '\\n\\n\\n----\\nPackaged project: ' + document.title + '\\n' + navigator.userAgent + '\\n';
        return 'https://github.com/forkphorus/forkphorus/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(before + baseBody + after) + '&labels=bug';
      }

      function updateLayout() {
        if (!stage) return;
        var w = Math.min(window.innerWidth, window.innerHeight / .75);
        var h = w * .75;
        root.style.left = (window.innerWidth - w) / 2 + 'px';
        root.style.top = (window.innerHeight - h) / 2 + 'px';
        stage.setZoom(w / 480);
        stage.draw();
      }

      window.addEventListener('resize', updateLayout);

      fetch(project)
        .then((request) => request.arrayBuffer())
        .then((buffer) => {
          if (type === 'sb3') {
            var loader = new P.sb3.SB3FileLoader(buffer);
            return loader.load();
          } else if (type === 'sb2') {
            return P.sb2.loadSB2Project(buffer);
          } else {
            throw new Error('Invalid project type: ' + type);
          }
        })
        .then((s) => {
          stage = s;
          // post-load script
          ${options.postLoadScript}
          // end script
          splash.style.display = 'none';
          root.appendChild(stage.root);
          updateLayout();
          stage.runtime.handleError = showError;
          stage.runtime.start();
          stage.runtime.triggerGreenFlag();
          stage.focus();
        })
        .catch((err) => showError(err));
    }());
    </script>
  </body>

  </html>`;
  }

  /**
   * Gets the active options
   * @returns {Options}
   */
  function getOptions() {
    return {
      loadingText: inputLoadingText.value,
      postLoadScript: inputPostLoadScript.value,
      customStyle: inputCustomStyle.value,
    };
  }

  /**
   * Downloads a string to the user's computer
   * @param {string} text The file content
   * @param {string} fileName The name of the downloaded file
   */
  function addDownloadLink(text, fileName) {
    function getBlob() {
      if ('TextEncoder' in window) {
        // firefox, chrome
        const encoder = new TextEncoder();
        return new Blob([encoder.encode(text)]);
      } else {
        // Using TextEncoder is the best method, but Edge doesn't support it.
        const bytes = new Array(text.length);
        for (let i = 0; i < text.length; i++) {
          bytes[i] = text.charCodeAt(i);
        }
        return new Blob([new Uint8Array(bytes)]);
      }
    }
    const link = document.createElement('a');
    const blob = getBlob();
    const size = blob.size / 1024 / 1024;
    link.href = URL.createObjectURL(blob);
    link.textContent = `Download ${fileName} (${size.toFixed(2)} MiB)`;
    link.download = fileName;
    sectionLoading.appendChild(link);
    link.click();
  }

  /**
   * Runs the packager.
   */
  function run() {
    removeProgressBars();
    return loadSources()
      .then(() => {
        const projectType = /** @type {HTMLInputElement} */ (document.querySelector('input[name=project-type]:checked')).value;
        if (projectType === 'id') {
          return getProjectById(inputProjectId.value);
        } else {
          return getProjectByFile(inputProjectFile.files[0]);
        }
      }).then((result) => {
        const html = getProjectHTML(result);
        addDownloadLink(html, 'project.html');
      })
      .catch((err) => {
        alert('Error: ' + err);
        console.error(err);
      });
  }

  packageHtmlButton.addEventListener('click', run);

  document.querySelectorAll('input[name=project-type]').forEach((el) => {
    el.addEventListener('click', (e) => {
      sectionProjectFile.hidden = /** @type {HTMLInputElement} */(e.target).value !== 'file';
      sectionProjectId.hidden = /** @type {HTMLInputElement} */(e.target).value !== 'id';
    });
  });
}());
