const fs = require('fs');
const path = require('path');
const validator = require('xsd-schema-validator');
const chalk = require('chalk');
const glob = require('glob-promise');
const xml2js = require('xml2js-es6-promise');
const _ = require('lodash');
const cliprogress = require('cli-progress');
const readdir = require('recursive-readdir');
const moment = require('moment');
const { timeout, TimeoutError } = require('promise-timeout');
const PromisePool = require('es6-promise-pool');
const yargs = require('yargs')

const { log } = console;


let options = {
  projectpath: 'cartridges/app_project/cartridge',
  sfrapath: 'exports/storefront-reference-architecture/cartridges/app_storefront_base/cartridge',
  timeout: 5000
}

async function xsdfy() {
  let files = await findXmlFiles();
  let xsdmap = buildXsdMapping();
  for (let j = 0; j < files.length; j++) {
    let xml = files[j];
    let xmllocal = path.relative(process.cwd(), xml);
    let xmlcontent = fs.readFileSync(xml, 'UTF-8');
    let ns = getNamespace(xmlcontent);
    let schemaLocation = getSchemaLocation(xmlcontent);

    if (schemaLocation) {
      log(chalk.green(`File ${xmllocal} already mapped to ${schemaLocation}`));
    } else {
      let xsdfile = xsdmap.get(ns);
      if (xsdfile) {
        let xsdrelative = path.relative(xml, xsdfile);
        log(chalk.yellow(`Adding xsd to ${xml} -> ${xsdrelative}`));

        xmlcontent = xmlcontent.replace(`${ns}"`, `${ns}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${ns} ${xsdrelative}"`);
        fs.writeFileSync(xml, xmlcontent);
      } else {
        log(chalk.yellow(`Unmapped: ${xml}`));
      }
    }
  }
}

async function validate(failsonerror) {
  let files = await findXmlFiles();
  let xsdmap = buildXsdMapping();

  let results = [];

  let message = `Validating ${files.length} xml files using sfcc schemas`;
  const progress = new cliprogress.Bar({
    format: `${chalk.green(message)} [${chalk.cyan('{bar}')}] {percentage}% | {value}/{total}`
  }, cliprogress.Presets.rect);
  progress.start(files.length, 0);

  let count = 0;
  let promisecount = 0

  let pool = new PromisePool(() => {
    if (promisecount < files.length) {
      let xml = files[promisecount];
      promisecount++
      return new Promise(async (resolve) => {
        let xmlcontent = fs.readFileSync(xml, 'UTF-8');
        let filename = path.basename(xml);

        progress.update(++count);

        let ns = getNamespace(xmlcontent);
        if (!ns) {
          chalk.red(`Namespace not found for ${filename}`);
        }

        let xsd = xsdmap.get(ns);

        if (!xsd) {
          if (ns !== 'http://www.demandware.com/xml/impex/accessrole/2007-09-05') { // exclude known missing ns
            log(chalk.yellow(`No xsd found for namespace ${ns}`));
          }
          resolve();
        } else {
          let res = {};

          try {
            // console.log(chalk.yellow(`Applying timeout to ${xml}`));
            res = await timeout(validateXml(xml, xsd), options.timeout);
          }
          catch (err) {
            if (err instanceof TimeoutError) {
              // console.error(`Timeout validating ${xml}`);
              res = {
                xml: xml,
                valid: false,
                processerror: 'true',
                messages: [`Validation timeout after ${options.timeout}ms`]
              };
            }
          }

          //  console.log(chalk.green(`Done with ${xml}`));
          results.push(res);
          resolve();
        }
      })
    }
    return null;
  }, 20);

  await pool.start();

  progress.stop();
  let successcount = results.filter(i => i.valid).length;
  let errorcount = results.filter(i => !i.valid && !i.processerror).length;
  let notvalidated = results.filter(i => i.processerror).length;

  if (errorcount > 0) {
    log(chalk`Validated ${results.length} files: {green ${successcount} valid} and {red ${errorcount} with errors}\n`);
  } else {
    log(chalk`Validated ${results.length} files: {green all good} 🍺\n`);
  }
  if (notvalidated > 0) {
    log(chalk.yellow(`${notvalidated} files cannot be validated (environment problems or timeout)\n`));
  }

  results.forEach((result) => {
    if (!result.valid) {
      log(chalk.redBright(`File ${result.xml} invalid:`));
      result.messages.forEach(i => {
        let msg = i;
        if (msg && msg.indexOf && msg.indexOf('cvc-complex-type') > -1 && msg.indexOf(': ') > -1) {
          msg = msg.substr(msg.indexOf(': ') + 2)
        }
        log(chalk.redBright(`● ${msg}`));
      });
      if (result.messages.length === 0) {
        log(chalk.redBright(`● ${JSON.stringify(result)}`));
      }
      log('\n');
    }
  });

  if (failsonerror && errorcount > 0) {
    log(chalk.redBright(`${errorcount} xml files failed validation\n`));
    process.exit(2); // fail build
    throw new Error(`${errorcount} xml files failed validation`);
  }
}

async function findXmlFiles() {
  return glob(`${path.join(process.cwd(), 'sites')}/**/*.xml`);
}

function buildXsdMapping() {
  let xsdfolder = path.join(process.cwd(), 'node_modules/sfcc-schemas/xsd/');
  let xsdmap = new Map();
  fs.readdirSync(xsdfolder).forEach((file) => {
    let fullpath = path.join(xsdfolder, file);
    let ns = getNamespace(fs.readFileSync(fullpath, 'utf-8'));
    if (ns) {
      xsdmap.set(ns, fullpath);
    } else {
      chalk.red(`Namespace not found in xsd ${fullpath}`);
    }
  });
  return xsdmap;
}

function getNamespace(xmlcontent) {
  let match = xmlcontent.match(new RegExp('xmlns(?::loc)? *= *"([a-z0-9/:.-]*)"'));
  if (match) {
    return match[1];
  }
  return null;
}

function getSchemaLocation(xmlcontent) {
  let match = xmlcontent.match(/xsi:schemaLocation="(.*)"/);
  // let match = xmlcontent.match(new RegExp('xsi:schemaLocation="([.|\n]*)"'));
  if (match) {
    return match[1];
  }
  return null;
}

async function validateXml(xml, xsd) {
  return new Promise((resolve) => {
    // process.stdout.write('.');
    validator.validateXML({ file: xml }, xsd, (err, result) => {
      if (err) {
        if (result) {
          if (!result.messages || result.messages.length === 0) {
            result.messages.push(err);
            result.processerror = true;
          }
        } else {
          log(chalk.red(err));
          return {};
        }
      }
      result.xml = xml;
      result.xsd = xsd;
      resolve(result);
    });
  });
}


async function parseMeta(source) {
  let exts = await xml2js(fs.readFileSync(source, 'utf-8'), {
    trim: true,
    normalizeTags: true,
    mergeAttrs: true,
    explicitArray: false,
    attrNameProcessors: [function (name) { return _.replace(name, /-/g, ''); }],
    tagNameProcessors: [function (name) { return _.replace(name, /-/g, ''); }]
  });

  if (exts.metadata && exts.metadata.typeextension) {
    ensureArray(exts.metadata, 'typeextension');
    exts = exts.metadata.typeextension.map(i => cleanupEntry(i)).filter(i => i.attributedefinitions);
  } else if (exts.metadata && exts.metadata.customtype) {
    ensureArray(exts.metadata, 'customtype');
    exts = exts.metadata.customtype.map(i => cleanupEntry(i));
  }

  ensureArray(exts.urlrules, 'pipelinealiases');

  cleanI18n(exts);

  fs.writeFileSync(path.join(process.cwd(), 'output/config/', `${path.basename(source)}.json`), JSON.stringify(exts, null, 2));

  // date parsing utils
  exts.moment = moment;
  return exts;
}

function ensureArray(object, field) {
  if (object && object[field] && !object[field].length) {
    object[field] = [object[field]];
  }
}

function cleanupEntry(i) {
  let res = i;

  // normalize
  if (res.customattributedefinitions) {
    res.attributedefinitions = res.customattributedefinitions;
    delete res.customattributedefinitions;
  }
  delete res.systemattributedefinitions;
  // cleanup single attributes without array
  if (res.attributedefinitions && res.attributedefinitions.attributedefinition && res.attributedefinitions.attributedefinition.attributeid) {
    res.attributedefinitions.attributedefinition = [res.attributedefinitions.attributedefinition];
  }
  return res;
}

function cleanI18n(obj) {
  Object
    .entries(obj)
    .forEach(entry => {
      let [k, v] = entry
      if (v !== null && typeof v === 'object' && !v.escape) {
        if (v._ && v['xml:lang'] && Object.keys(v).length === 2) {
          obj[k] = v._;
          // log(`-> replaced ${obj[k]}`);
        }
        cleanI18n(v);
      }
    })
}

async function entrypoints() {
  const regex = /server\.(get|post)\(['" \n]*([a-zA-Z0-9]*)['" ]*/gm;


  let inputpath = path.join(process.cwd(), 'output/code');
  if (!fs.existsSync(inputpath)) {
    return;
  }

  let files = await readdir(inputpath, [(i, stats) => !stats.isDirectory() && path.basename(path.dirname(i)) !== "controllers" && path.extname(i) !== "js"]);

  let mapping = {};
  for (let j = 0; j < files.length; j++) {
    let file = files[j];
    let controllername = path.basename(file);
    controllername = controllername.substr(0, controllername.lastIndexOf('.'));
    let dirname = path.basename(path.dirname(path.dirname(path.dirname(file))));

    let filecontent = fs.readFileSync(file);

    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = regex.exec(filecontent)) !== null) {
      if (m.index === regex.lastIndex) {
        regex.lastIndex++;
      }
      let pipeline = `${controllername}-${m[2]}`;
      let method = _.upperCase(m[1]);

      if (mapping[pipeline]) {
        mapping[pipeline].cartridges.push(dirname);
      } else {
        mapping[pipeline] = {
          pipeline: pipeline,
          method: method,
          controller: controllername,
          cartridges: [dirname]
        };
      }
    }
  }

  return mapping;
}

async function listcontrollers() {
  let projectbase = path.join(process.cwd(), options.projectpath);

  if (!fs.existsSync(projectbase)) {
    log(`Skipping controller docs, folder ${projectbase} not available`);
    return;
  }

  let files = await readdir(path.join(projectbase, 'controllers'));
  files = files.map(i => path.relative(projectbase, i));

  let sfrabase = path.join(process.cwd(), options.projectpath);
  sfrabase = path.join(process.cwd(), options.sfrapath);
  let sfrafiles = await readdir(path.join(sfrabase, 'controllers'));
  sfrafiles = sfrafiles.map(i => path.relative(sfrabase, i));

  let controllers = files.map(i => ({
    name: i,
    project: true,
    sfra: sfrafiles.includes(i)
  }));
  let sfracontrollers = sfrafiles.filter(i => !files.includes(i)).map(i => ({
    name: i,
    project: false,
    sfra: true
  }));

  controllers = controllers.concat(sfracontrollers);


  let templates = await readdir(path.join(projectbase, 'templates/default'));
  templates = templates.map(i => path.relative(projectbase, i));

  let sfratemplates = await readdir(path.join(sfrabase, 'templates/default'));
  sfratemplates = sfratemplates.map(i => path.relative(sfrabase, i));

  let templatesprj = templates.map(i => ({
    name: i,
    project: true,
    sfra: sfratemplates.includes(i)
  }));

  let context = {
    controllers: controllers,
    templates: templatesprj
  }

  let output = path.join(process.cwd(), 'output/config/', 'controllers.html');
  fs.writeFileSync(output, _.template(fs.readFileSync(path.resolve(__dirname, `templates/controllers.html`), 'utf-8'))(context));
  log(chalk.green(`Generated documentation at ${output}`));
}


async function metacheatsheet() {
  const argv = yargs.argv;

  options.projectpath = argv.projectpath || options.projectpath;
  options.sfrapath = argv.sfrapath || options.sfrapath;

  await buildMeta();

  await buildFromXml('sites/site_template/services.xml', 'services.html');
  await buildFromXml('sites/site_template/jobs.xml', 'jobs.html');

  await buildSeo('url-rules.xml', 'seo.html');

  await buildFromXml('sites/site_template/pagemetatag.xml', 'pagemetatag.html');

  await listcontrollers();

  await buildAssetDoc();
}

async function buildMeta() {
  let definitionspath = path.join(process.cwd(), 'sites/site_template/meta/custom-objecttype-definitions.xml');
  let extensionspath = path.join(process.cwd(), 'sites/site_template/meta/system-objecttype-extensions.xml');
  let exts = await parseMeta(extensionspath);
  let defs = await parseMeta(definitionspath);
  let context = {
    extensions: exts,
    definitions: defs
  };
  let output = path.join(process.cwd(), 'output/config/', 'metacheatsheet.html');
  fs.writeFileSync(output, _.template(fs.readFileSync(path.resolve(__dirname, `templates/meta.html`), 'utf-8'))(context));
  log(chalk.green(`Generated documentation at ${output}`));
}

async function buildFromXml(input, html) {
  let inputpath = path.join(process.cwd(), input);
  if (!fs.existsSync(inputpath)) {
    return;
  }
  let output = path.join(process.cwd(), 'output/config/', html);
  fs.writeFileSync(output, _.template(fs.readFileSync(path.resolve(__dirname, `templates/${html}`), 'utf-8'))(await parseMeta(inputpath)));
  log(chalk.green(`Generated documentation at ${output}`));
}

async function buildSeo(xml, html) {
  let mappings = await entrypoints();
  let context = await parseXmlSites(xml, 'seo.html');

  if (!context) {
    return;
  }

  context.sites.forEach(site => {
    let siteentrypoints = JSON.parse(JSON.stringify(mappings));
    if (site.urlrules && site.urlrules.pipelinealiases && site.urlrules.pipelinealiases[0]) {
      site.urlrules.pipelinealiases[0].pipelinealias.forEach(alias => {
        if (siteentrypoints[alias.pipeline]) {
          siteentrypoints[alias.pipeline].alias = alias._;
        } else {
          // console.log(`Not existing remapping: ${alias._}=${alias.pipeline}`);
          siteentrypoints[alias.pipeline] = {
            alias: alias._,
            pipeline: alias.pipeline,
            controller: alias.pipeline.substr(0, alias.pipeline.indexOf('-')),
            cartridges: []
          }
        }
      });
    }

    let entrypointsarray = Object.keys(siteentrypoints).map(i => siteentrypoints[i]).sort((a, b) => a.pipeline.localeCompare(b.pipeline));

    site.entrypoints = entrypointsarray;
  })


  let output = path.join(process.cwd(), 'output/config/', html);
  fs.writeFileSync(output, _.template(fs.readFileSync(path.resolve(__dirname, `templates/${html}`), 'utf-8'))(context));
  log(chalk.green(`Generated documentation at ${output}`));
}

async function isml() {
  let inputpath = path.join(process.cwd(), `${options.projectpath}/templates/default`);
  if (!fs.existsSync(inputpath)) {
    return;
  }
  let sfrapath = path.join(process.cwd(), `${options.sfrapath}/templates/default`);


  let sfrafiles = await readdir(sfrapath);
  let mapping = sfrafiles.filter(i => path.extname(i) === '.isml').map(i => ({
    path: i,
    template: path.relative(sfrapath, i),
    type: 'sfra'
  })
  );

  let files = await readdir(inputpath);
  let projectmapping = files.filter(i => path.extname(i) === '.isml').map(i => ({
    path: i,
    template: path.relative(inputpath, i),
    type: 'project'
  })
  );


  projectmapping.forEach(i => {
    let idx = mapping.findIndex(p => p.template === i.template);
    if (idx) {
      mapping.splice(idx, 1);
    }
  });

  return mapping.concat(projectmapping).sort((a, b) => a.template.localeCompare(b.template));
}


async function buildAssetDoc() {
  let html = 'assets.html';
  let ismls = await isml();

  if (!ismls) {
    return;
  }


  const assetsregexp = /iscontentasset['" a-zA-Z0-9-/\n]* aid="([a-zA-Z0-9-_/]*)/gm;
  const slotregexp = /isslot['" a-zA-Z0-9-/\n]* id="([a-zA-Z0-9-_/]*)/gm;
  const includesregexp = /isinclude['" a-zA-Z0-9-/\n]* template="([a-zA-Z0-9-_/]*)/gm;

  ismls.forEach(i => {
    let filecontent = fs.readFileSync(i.path);

    i.assets = regexpmatch(assetsregexp, filecontent);
    i.slots = regexpmatch(slotregexp, filecontent);
    i.includes = regexpmatch(includesregexp, filecontent);
  });

  ismls = ismls.filter(i => i.assets.length !== 0 || i.slots.length !== 0 || i.includes.length !== 0);


  // log('isml:', JSON.stringify(ismls, null, 2));

  let contentonly = ismls.filter(i => i.assets.length !== 0 || i.slots.length !== 0);


  let output = path.join(process.cwd(), 'output/config/', html);
  fs.writeFileSync(output, _.template(fs.readFileSync(path.resolve(__dirname, `templates/${html}`), 'utf-8'))({ templates: ismls, content: contentonly }));
  log(chalk.green(`Generated documentation at ${output}`));
}

function regexpmatch(regex, filecontent) {
  let matches = [];
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = regex.exec(filecontent)) !== null) {
    if (m.index === regex.lastIndex) {
      regex.lastIndex++;
    }
    matches.push(m[1]);
  }
  return matches;
}

async function parseXmlSites(filename, html) {
  let files = await readdir(path.join(process.cwd(), 'sites/site_template/sites/'), [(i, stats) => !stats.isDirectory() && path.basename(i) !== "url-rules.xml"]);

  if (!files || files.length === 0) {
    return;
  }

  let context = { sites: [] };

  for (let j = 0; j < files.length; j++) {
    let single = await parseMeta(files[j]);
    single.id = path.basename(path.dirname(files[j]));

    context.sites.push(single);
  }

  return context;
}


// eslint-disable-next-line no-unused-vars
async function buildFromXmlSites(filename, html) {
  let context = await parseXmlSites(filename, html);

  let output = path.join(process.cwd(), 'output/config/', html);
  fs.writeFileSync(output, _.template(fs.readFileSync(path.resolve(__dirname, `templates/${html}`), 'utf-8'))(context));
  log(chalk.green(`Generated documentation at ${output}`));
}


module.exports = { validate, xsdfy, metacheatsheet };
