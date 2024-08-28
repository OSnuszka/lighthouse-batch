"use strict";
require("shelljs/global");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const OUT = "./report/lighthouse";
const REPORT_SUMMARY = "summary.json";
const JSON_EXT = ".report.json";
const CSV_EXT = ".report.csv";
const HTML_EXT = ".report.html";

execute.OUT = OUT;
module.exports = execute;

function execute(options) {
  log = log.bind(log, options.verbose || false);

  const out = options.out || OUT;
  const lhScript = lighthouseScript(options, log);
  const summaryPath = path.join(out, REPORT_SUMMARY);

  try {
    const files = fs.readdirSync(out);
    files.forEach((f) => {
      if (
        f.endsWith(JSON_EXT) ||
        f.endsWith(HTML_EXT) ||
        f.endsWith(CSV_EXT) ||
        f == REPORT_SUMMARY
      ) {
        const oldFile = path.join(out, f);
        log(`Removing old report file: ${oldFile}`);
        rm("-f", oldFile);
      }
    });
  } catch (e) {}

  mkdir("-p", out);

  let budgetErrors = [];
  const count = options.sites.length;
  log(`Lighthouse batch run begin for ${count} site${count > 1 ? "s" : ""}`);

  const collectedMetrics = {
    firstContentfulPaint: [],
    largestContentfulPaint: [],
    totalBlockingTime: [],
    speedIndex: [],
    cumulativeLayoutShift: [],
  };

  const reports = sitesInfo(options)
    .map((site, i) => {
      if (budgetErrors.length && options.failFast) {
        return undefined;
      }
      const prefix = `${i + 1}/${count}: `;
      const htmlOut = options.html ? " --output html" : "";
      const csvOut = options.csv ? " --output csv" : "";
      const filePath = path.join(out, site.file);
      const customParams = options.params || "";
      const chromeFlags =
        customParams.indexOf("--chrome-flags=") === -1
          ? `--chrome-flags="--no-sandbox --headless --disable-gpu"`
          : "";
      const outputPath =
        options.html || options.csv
          ? filePath.slice(0, -JSON_EXT.length)
          : filePath;
      const cmd = `"${site.url}" --output json${
        htmlOut + csvOut
      } --output-path "${outputPath}" ${chromeFlags} ${customParams}`;

      log(`${prefix}Lighthouse analyzing '${site.url}'`);
      log(cmd);
      const outcome = exec(`${lhScript} ${cmd}`);
      const summary = updateSummary(filePath, site, outcome, options);

      if (summary.error)
        console.warn(`${prefix}Lighthouse analysis FAILED for ${summary.url}`);
      else
        log(
          `${prefix}Lighthouse analysis of '${summary.url}' complete with score ${summary.score}`
        );

      if (options.report === false) {
        log(`Removing generated report file '${filePath}'`);
        rm(filePath);
      }

      const errors = checkBudgets(summary, options);
      if (errors) {
        const other = summary.errors;
        summary.errors = {
          budget: errors,
        };
        if (other) {
          summary.errors.other = other;
        }
        budgetErrors = budgetErrors.concat(errors);
      }

      // Collect metrics for average calculation
      collectedMetrics.firstContentfulPaint.push(summary.audits['first-contentful-paint'].numericValue);
      collectedMetrics.largestContentfulPaint.push(summary.audits['largest-contentful-paint'].numericValue);
      collectedMetrics.totalBlockingTime.push(summary.audits['total-blocking-time'].numericValue);
      collectedMetrics.speedIndex.push(summary.audits['speed-index'].numericValue);
      collectedMetrics.cumulativeLayoutShift.push(summary.audits['cumulative-layout-shift'].numericValue);

      return summary;
    })
    .filter((summary) => !!summary);

  console.log(`Lighthouse batch run end`);
  console.log(`Writing reports summary to ${summaryPath}`);

  const averages = calculateAverages(collectedMetrics, reports.length);

  fs.writeFileSync(summaryPath, JSON.stringify({ reports, averages }), "utf8");
  if (options.print) {
    console.log(`Printing reports summary`);
    console.log(JSON.stringify({ reports, averages }, null, 2));
  }

  if (budgetErrors.length) {
    console.error(`Error: failed to meet budget thresholds`);
    for (let err of budgetErrors) {
      console.error(` - ${err}`);
    }
    log("Exiting with code 1");
    process.exit(1);
  }
}

function calculateAverages(metrics, count) {
  const averages = {};
  for (const key in metrics) {
    const total = metrics[key].reduce((acc, value) => acc + value, 0);
    averages[key] = (total / count).toFixed(10);
  }
  return averages;
}

function sitesInfo(options) {
  let sites = [];
  if (options.file) {
    try {
      const contents = fs.readFileSync(options.file, "utf8");
      sites = contents.trim().split("\n");
    } catch (e) {
      console.error(`Failed to read file ${options.file}, aborting.\n`, e);
      log("Exiting with code 1");
      process.exit(1);
    }
  }
  if (options.sites) {
    sites = sites.concat(options.sites);
  }
  const existingNames = {};
  return sites.map((url) => {
    url = url.trim();
    if (!url.match(/^https?:/)) {
      if (!url.startsWith("//")) url = `//${url}`;
      url = `https:${url}`;
    }
    const origName = siteName(url);
    let name = origName;

    let j = 1;
    while (existingNames[name]) {
      name = `${origName}_${j}`;
      j++;
    }
    existingNames[name] = true;

    const info = {
      url,
      name,
      file: `${name}${JSON_EXT}`,
    };
    if (options.html) info.html = `${name}${HTML_EXT}`;
    if (options.csv) info.csv = `${name}${CSV_EXT}`;
    return info;
  });
}

function lighthouseScript(options, log) {
  if (options.useGlobal) {
    if (exec("lighthouse --version").code === 0) {
      log("Targeting global install of Lighthouse cli");
      return "lighthouse";
    } else {
      console.warn(
        "Global Lighthouse install not found, falling back to local one"
      );
    }
  }
  let cliPath = path.resolve(
    `${__dirname}/node_modules/lighthouse/cli/index.js`
  );
  if (!fs.existsSync(cliPath)) {
    cliPath = path.resolve(
      `${__dirname}/../lighthouse/cli/index.js`
    );
    if (!fs.existsSync(cliPath)) {
      console.error(`Failed to find Lighthouse CLI, aborting.`);
      process.exit(1);
    }
  }
  log(`Targeting local Lighthouse cli at '${cliPath}'`);
  return `node ${cliPath}`;
}

function siteName(site) {
  const maxLength = 100;
  let name = site
    .replace(/^https?:\/\//, "")
    .replace(/[\/\?#:\*\$@\!\.]/g, "_");

  if (name.length > maxLength) {
    const hash = crypto
      .createHash("sha1")
      .update(name)
      .digest("hex")
      .slice(0, 7);

    name = name.slice(0, maxLength).replace(/_+$/g, ""); // trim any `_` suffix
    name = `${name}_${hash}`;
  }
  return name;
}

function updateSummary(filePath, summary, outcome, options) {
  if (outcome.code !== 0) {
    summary.score = 0;
    summary.error = outcome.stderr;
    return summary;
  }
  const report = JSON.parse(fs.readFileSync(filePath));
  return {
    ...summary,
    audits: {
      'first-contentful-paint': {
        displayValue: report.audits['first-contentful-paint'].displayValue,
        numericValue: report.audits['first-contentful-paint'].numericValue
      },
      'largest-contentful-paint': {
        displayValue: report.audits['largest-contentful-paint'].displayValue,
        numericValue: report.audits['largest-contentful-paint'].numericValue
      },
      'total-blocking-time': {
        displayValue: report.audits['total-blocking-time'].displayValue,
        numericValue: report.audits['total-blocking-time'].numericValue
      },
      'speed-index': {
        displayValue: report.audits['speed-index'].displayValue,
        numericValue: report.audits['speed-index'].numericValue
      },
      'cumulative-layout-shift': {
        displayValue: report.audits['cumulative-layout-shift'].displayValue,
        numericValue: report.audits['cumulative-layout-shift'].numericValue
      }
    },
    ...getAverageScore(report),
  };
}

function getAverageScore(report) {
  let categories = report.reportCategories; // lighthouse v1,2
  
  if (report.categories) {
    // lighthouse v3
    categories = Object.values(report.categories);
  }
  let total = 0;
  const detail = categories.reduce((acc, cat) => {
    if (cat.id) acc[cat.id] = cat.score;
    total += cat.score;
    return acc;
  }, {});
  return {
    score: Number((total / categories.length).toFixed(2)),
    detail,
  };
}

function checkBudgets(summary, options) {
  const errors = [];
  if (options.score > 0) {
    const score = toScore(summary.score);
    if (score < options.score) {
      errors.push(
        `average score ${score} < ${options.score} for ${summary.url}`
      );
    }
  }

  if (options.accessibility > 0 && summary.detail) {
    const score = toScore(summary.detail.accessibility);
    if (score < options.accessibility) {
      errors.push(
        `accessibility score ${score} < ${options.accessibility} for ${summary.url}`
      );
    }
  }

  if (options.performance > 0 && summary.detail) {
    const score = toScore(summary.detail.performance);
    if (score < options.performance) {
      errors.push(
        `performance score ${score} < ${options.performance} for ${summary.url}`
      );
    }
  }

  if (options.bestPractices > 0 && summary.detail) {
    const score = toScore(summary.detail["best-practices"]);
    if (score < options.bestPractices) {
      errors.push(
        `best practices score ${score} < ${options.bestPractices} for ${summary.url}`
      );
    }
  }

  if (options.seo > 0 && summary.detail) {
    const score = toScore(summary.detail.seo);
    if (score < options.seo) {
      errors.push(
        `seo score ${score} < ${options.seo} for site ${summary.url}`
      );
    }
  }

  if (options.pwa > 0 && summary.detail) {
    const score = toScore(summary.detail.pwa);
    if (score < options.pwa) {
      errors.push(
        `pwa score ${score} < ${options.pwa} for site ${summary.url}`
      );
    }
  }

  return errors.length ? errors : undefined;
}

function log(v, msg) {
  if (v) console.log(msg);
}

function toScore(score) {
  return Number(score) * 100;
}
