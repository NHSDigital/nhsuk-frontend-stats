import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Octokit } from "octokit";

// Load local dev credentials; in CI, GITHUB_TOKEN is already set and no .env file exists
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function getFileContent(owner, repo, path) {
  const response = await octokit.rest.repos.getContent({ owner, repo, path });
  return Buffer.from(response.data.content, "base64").toString("utf8");
}

const data = JSON.parse(await readFile("data.json", "utf8"));

const remainingServices = [];

for (const service of data.services) {
  const [owner, repo] = service.github.replace("https://github.com/", "").split("/");

  try {
    await octokit.rest.repos.get({ owner, repo });
  } catch (error) {
    // GitHub returns 404 (not 403) for both deleted repos and private ones the token can't see,
    // so that's the only reliable "gone" signal. 403 covers other things (rate limits, SAML/SSO
    // enforcement, org token policies) that don't mean the repo disappeared, so keep the entry.
    if (error.status === 404) {
      console.warn(`Removing "${service.name}": ${owner}/${repo} is no longer accessible (404)`);
      continue;
    }

    if (error.status === 403) {
      console.warn(`Skipping "${service.name}" this run: ${owner}/${repo} returned 403 (${error.message})`);
      remainingServices.push(service);
      continue;
    }

    throw error;
  }

  remainingServices.push(service);

  const packageLocation = service.packageLocation ?? "";

  try {
    const packageJson = JSON.parse(await getFileContent(owner, repo, `${packageLocation}package.json`));

    if (packageJson.dependencies?.["nhsuk-frontend"]) {
      service.nhsukFrontendVersion = packageJson.dependencies["nhsuk-frontend"];
    }

    if (packageJson.dependencies?.["nhsuk-react-components"]) {
      service.nhsukReactComponentsVersion = packageJson.dependencies["nhsuk-react-components"];
    }
  } catch (error) {
    // Ignore missing/inaccessible repos, same as the previous Ruby rescue blocks
    if (error.status !== 404 && error.status !== 403) throw error;
  }

  try {
    const packageLockJson = JSON.parse(await getFileContent(owner, repo, `${packageLocation}package-lock.json`));

    // npm v2/v3 lockfile format
    if (packageLockJson.packages?.["node_modules/nhsuk-frontend"]) {
      service.nhsFrontendVersionPackageLock = packageLockJson.packages["node_modules/nhsuk-frontend"].version;
    // npm v1 lockfile format
    } else if (packageLockJson.dependencies?.["nhsuk-frontend"]) {
      service.nhsFrontendVersionPackageLock = packageLockJson.dependencies["nhsuk-frontend"].version;
    }
  } catch (error) {
    if (error.status === 404) {
      // Fall back to yarn.lock
      try {
        const yarnLock = await getFileContent(owner, repo, `${packageLocation}yarn.lock`);

        // Match a block starting with "nhsuk-frontend@..." and extract its resolved version
        const match = yarnLock.match(/^"?nhsuk-frontend@[^:]+:?\n(?:.*\n)*?\s+version[:\s]+"?([^\s"]+)"?/m);

        if (match) {
          service.nhsFrontendVersionPackageLock = match[1];
        }
      } catch (yarnError) {
        if (yarnError.status !== 404 && yarnError.status !== 403) throw yarnError;
      }
    } else if (error.status !== 403) {
      throw error;
    }
  }
}

data.services = remainingServices;

// Update data file
await writeFile("data.json", JSON.stringify(data, null, 2) + "\n");

data.services.sort((a, b) => {
  const versionA = String(a.nhsukFrontendVersion ?? "").replace(/[\^~]/g, "");
  const versionB = String(b.nhsukFrontendVersion ?? "").replace(/[\^~]/g, "");

  if (versionA < versionB) return 1;
  if (versionA > versionB) return -1;
  return a.name.localeCompare(b.name);
});

// Update README.md
let readme = "The following table shows the current version of [NHSUK Frontend](https://github.com/nhsuk/nhsuk-frontend) used by different services.\n\n";
readme += "| Service | Frontend version | Installed version |\n";
readme += "| :------ | -------------------: | -------------------: |\n";

for (const service of data.services) {
  const name = service.name ?? "";
  const url = service.github ?? "";
  const frontendVersion = service.nhsukFrontendVersion ?? "";
  const installedVersion = service.nhsFrontendVersionPackageLock ?? "";

  readme += `| [${name}](${url}) | ${frontendVersion} | ${installedVersion} |\n`;
}

await writeFile("README.md", readme);
