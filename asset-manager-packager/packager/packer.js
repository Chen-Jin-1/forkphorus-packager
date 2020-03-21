// @ts-check

// @ts-ignore
window.Packer = (function() {
  'use strict';

  // @ts-ignore
  const SBDL = window.SBDL;
  // @ts-ignore
  const JSZip = window.JSZip;

  /**
   * A file that represents a script or stylesheet to be included in the packager output.
   * @typedef {Object} PackagerFile
   * @property {'script'|'style'} type The type of file
   * @property {string} src Where to fetch the file from, relative to the forkphorus root
   * @property {boolean} [loaded] Whether the file has been loaded.
   * @property {string} [content] Raw text of the file
   */

  /**
   * A runtime asset to be included in the packager output.
   * @typedef {Object} PackagerAsset
   * @property {string} src Where to fetch the file from, relative to the forkphorus root
   * @property {boolean} [loaded] Whether the file has been loaded.
   * @property {boolean} [data] Raw data of the asset in the form of a data: URI
   */

  /**
   * Convert a Blob to a data: URI
   * @param {Blob} blob Blob or file to be read
   */
  function readAsURL(blob) {
    return new Promise((resolve, reject) => {
      const fileReader = new FileReader();
      fileReader.onload = () => {
        resolve(/** @type {string} */ (fileReader.result));
      };
      fileReader.onerror = (e) => {
        reject('Error reading file');
      };
      fileReader.readAsDataURL(blob);
    });
  }

  /**
   * Helper class for users to implement progress monitoring.
   */
  class Progress {
    newTask() {}
    endTask() {}
    setProgress(progress) {}
    setCaption(text) {}
    start() {}
  }

  class FileLoader {
    constructor() {
      this.progress = new Progress();
      /** @type {PackagerFile[]} */
      this.files = [];
      /** @type {PackagerAsset[]} */
      this.assets = [];
    }

    /**
     * @param {PackagerFile} file
     */
    _loadFile(file) {
      return fetch('../' + file.src)
        .then((r) => r.text())
        .then((t) => {
          file.loaded = true;
          file.content = `/* F: ${file.src} */` + t;
        });
    }

    /**
     * @param {PackagerAsset} asset
     */
    _loadAsset(asset) {
      return fetch('../' + asset.src)
        .then((r) => r.blob())
        .then((b) => readAsURL(b))
        .then((url) => {
          asset.loaded = true;
          asset.data = url;
        });
    }

    /**
     * @param {PackagerFile[]} files
     */
    _concatenateFiles(files) {
      return files.map((i) => i.content).join('\n');
    }

    /**
     * Fetch & load any assets that have not yet been loaded.
     */
    async loadMissingAssets() {
      const missingFiles = this.files.filter((i) => !i.loaded);
      const missingAssets = this.assets.filter((i) => !i.loaded);

      if (missingFiles.length > 0 || missingAssets.length > 0) {
        this.progress.start();
        await Promise.all([
          ...missingFiles.map((i) => this._loadFile(i)),
          ...missingAssets.map((i) => this._loadAsset(i)),
        ]);
      }

      return {
        scripts: this._concatenateFiles(this.files.filter((i) => i.type === 'script')),
        styles: this._concatenateFiles(this.files.filter((i) => i.type === 'style')),
        assets: this.assets,
      };
    }
  }

  class Packager {
    constructor({ fileLoader }) {
      this.fileLoader = fileLoader;
      /** Options to be passed to the player. */
      this.playerOptions = {
        fullscreenPadding: 0,
        fullscreenMode: 'window',
      };

      /** Options to be passed to player.addControls(). if null, addControls() is not called. */
      this.controlsOptions = null;

      this.projectType = null;
      this.projectData = null;

      this.archiveProgress = new Progress();
    }

    /**
     * Create an archive from an SBDL files result
     * @param {*} files 
     */
    _createArchive(files) {
      this.archiveProgress.start();
      const zip = new JSZip();
      for (const file of files) {
        const path = file.path;
        const data = file.data;
        zip.file(path, data);
      }
      return zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
      }, (metadata) => {
        this.archiveProgress.setProgress(metadata.percent);
        this.archiveProgress.setCaption(metadata.currentFile);
      });
    }

    /**
     * @param {string} id
     */
    async _getProjectTypeById(id) {
      const res = await fetch('https://projects.scratch.mit.edu/' + id);
      if (res.status !== 200) {
        if (res.status === 404) {
          throw new Error('Project does not exist');
        }
        throw new Error('Cannot get project, got error code: ' + res.status);
      }
      const data = await res.json();
      if ('targets' in data) return 'sb3';
      if ('objName' in data) return 'sb2';
      throw new Error('unknown project type');
    }

    /**
     * @param {string} id
     */
    async _getProjectById(id) {
      const type = await this._getProjectTypeById(id);
      const result = await SBDL.loadProject(id, type);
      if (result.type !== 'zip') {
        throw new Error('unknown result type: ' + result.type);
      }
      const archive = await this._createArchive(result.files);
      const url = await readAsURL(archive);
      return {
        url: url,
        type: type,
      };
    }

    /**
     * Load a project using its ID on scratch.mit.edu
     * @param {string} id The project's ID
     */
    async loadProjectById(id) {
      const { url, type } = await this._getProjectById(id);
      this.projectData = url;
      this.projectType = type;
    }

    /**
     * Load a project from a File
     * @param {File} file The file to be read
     */
    async loadProjectFromFile(file) {
      if (!file) {
        throw new Error('Missing file');
      }
      const extension = file.name.split('.').pop();
      return new Promise((resolve, reject) => {
        const fileReader = new FileReader();
        fileReader.onload = () => {
          this.projectData = fileReader.result;
          this.projectType = extension;
          resolve();
        };
        fileReader.onerror = () => {
          reject('cannot read file');
        };
        fileReader.readAsDataURL(file);
      });
    }

    /**
     * Run the packager, and generate a result HTML page. Must be run after one of the load() methods resolves.
     */
    async run() {
      if (!this.projectData || !this.projectType) {
        throw new Error('missing project data or type');
      }

      const { scripts, styles, assets } = await this.fileLoader.loadMissingAssets();
      const assetManagerData = '{' + assets.map((asset) => `"${asset.src}": "${asset.data}"`).join(', ') + '}';

      const body = `<!DOCTYPE html>
<!-- Generated by the forkphorus packager: https://forkphorus.github.io/packager/ -->
<html>
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-inline' 'unsafe-eval' data: blob:">
    <style>
/* Forkphorus styles... */
${styles}
/* Player styles... */
body {
  background: #000;
  margin: 0;
  overflow: hidden;
}
.player {
  position: absolute;
}
.splash, .error {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: #000;
  display: table;
  color: #fff;
  cursor: default;
}
.error {
  display: none;
}
.splash > div,
.error > div {
  display: table-cell;
  height: 100%;
  text-align: center;
  vertical-align: middle;
}
.progress {
  width: 80%;
  height: 16px;
  border: 1px solid #fff;
  margin: 0 auto;
}
.progress-bar {
  background: #fff;
  width: 10%;
  height: 100%;
}
h1 {
  font: 300 72px Helvetica Neue, Helvetica, Arial, sans-serif;
  margin: 0 0 16px;
}
p {
  font: 300 24px/1.5 Helvetica Neue, Helvetica, Arial, sans-serif;
  margin: 0;
  color: rgba(255, 255, 255, .6);
}
.error a {
  color: #fff;
}
    </style>
  </head>
  <body>

    <div class="player"></div>
    <div class="splash">
      <div>
        <h1>forkphorus</h1>
        <div class="progress">
          <div class="progress-bar"></div>
        </div>
      </div>
    </div>
    <div class="error">
      <div>
        <h1>Internal Error</h1>
        <p class="error-report"></p>
      </div>
    </div>

    <script>
// Forkphorus scripts...
${scripts}
// Player scripts...
(function () {
  'use strict';

  var splash = document.querySelector('.splash');
  var error = document.querySelector('.error');
  var progressBar = document.querySelector('.progress');
  var progressBarFill = document.querySelector('.progress-bar');

  var splash = document.querySelector('.splash');
  var error = document.querySelector('.error');
  var progressBar = document.querySelector('.progress');
  var progressBarFill = document.querySelector('.progress-bar');

  var player = new P.player.Player();
  player.setOptions({ theme: 'dark' });
  var errorHandler = new P.player.ErrorHandler(player, {
    container: document.querySelector('.error-report'),
  });
  player.onprogress.subscribe(function(progress) {
    progressBarFill.style.width = (10 + progress * 90) + '%';
  });
  player.onerror.subscribe(function(e) {
    player.exitFullscreen();
    error.style.display = 'table';
  });
  document.querySelector('.player').appendChild(player.root);

  document.addEventListener('touchmove', function(e) {
    e.preventDefault();
  });

  P.io.setAssetManager(new class {
    constructor() {
      // Assets...
      this.data = ${assetManagerData};
    }

    loadSoundbankFile(src) {
      return this.fetch('soundbank/' + src).then(function(e) { return e.arrayBuffer(); });
    }

    loadFont(src) {
      return this.fetch(src).then(function(e) { return e.blob(); });
    }

    fetch(u) {
      return fetch(this.data[u]);
    }
  });

  // Project type...
  var type = '${this.projectType}';
  // Project data...
  var project = '${this.projectData}';

  // Player options...
  var playerOptions = ${JSON.stringify(this.playerOptions)};
  // Controls options...
  var controlsOptions = ${JSON.stringify(this.controlsOptions)};

  player.setOptions(playerOptions);
  if (controlsOptions) {
    player.addControls(controlsOptions);
  }

  fetch(project)
    .then(function(request) { return request.arrayBuffer(); })
    .then(function(buffer) { return player.loadProjectFromBuffer(buffer, type); })
    .then(function() {
      player.enterFullscreen();
      splash.style.display = 'none';
    })
    .catch(function(e) {
      player.handleError(e);
    });
}());
    </script>
  </body>
</html>`;
      return body;
    }
  }

  return {
    FileLoader,
    Packager,
  };
}());
