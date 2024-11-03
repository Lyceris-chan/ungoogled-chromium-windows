const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const glob = require('@actions/glob');

const CACHE_RETRY_ATTEMPTS = 5;
const CACHE_RETRY_DELAY = 10000;
const BUILD_FAILURE_DELAY = 5000;
const BUILD_PATH = 'C:\\ungoogled-chromium-windows';

async function saveToCache(paths, key, retryCount = CACHE_RETRY_ATTEMPTS) {
    for (let i = 0; i < retryCount; i++) {
        try {
            await cache.saveCache(paths, key);
            return true;
        } catch (e) {
            console.error(`Cache save attempt ${i + 1} failed: ${e}`);
            if (i < retryCount - 1) {
                await new Promise(r => setTimeout(r, CACHE_RETRY_DELAY));
            }
        }
    }
    return false;
}

async function run() {
    try {
        process.on('SIGINT', () => {});
        
        const finished = core.getBooleanInput('finished', { required: true });
        const fromCache = core.getBooleanInput('from_cache', { required: true });
        const x86 = core.getBooleanInput('x86', { required: false });
        
        console.log(`finished: ${finished}, from cache: ${fromCache}`);
        
        if (finished) {
            core.setOutput('finished', true);
            return;
        }

        const cacheKey = x86 ? 'build-cache-x86' : 'build-cache';
        const cachePath = `${BUILD_PATH}\\build`;

        if (fromCache) {
            const restoredCacheKey = await cache.restoreCache([cachePath], cacheKey);
            if (restoredCacheKey) {
                console.log(`Cache restored from key: ${restoredCacheKey}`);
                await exec.exec('7z', ['x', `${cachePath}\\artifacts.zip`, `-o${cachePath}`, '-y']);
                await io.rmRF(`${cachePath}\\artifacts.zip`);
            } else {
                console.log('No cache found, proceeding without cache');
            }
        }

        // Install dependencies and run build in parallel
        await Promise.all([
            exec.exec('python', ['-m', 'pip', 'install', 'httplib2'], {
                cwd: BUILD_PATH,
                ignoreReturnCode: true
            })
        ]);

        const buildArgs = ['build.py', '--ci'];
        if (x86) buildArgs.push('--x86');

        const retCode = await exec.exec('python', buildArgs, {
            cwd: BUILD_PATH,
            ignoreReturnCode: true
        });

        if (retCode === 0) {
            const globber = await glob.create(`${BUILD_PATH}\\build\\ungoogled-chromium*`, {
                matchDirectories: false
            });
            const packageList = await globber.glob();
            
            const cacheSaved = await saveToCache(packageList, cacheKey);
            if (!cacheSaved) {
                console.warn('Failed to save cache after multiple attempts');
            }
            
            core.setOutput('finished', true);
        } else {
            await new Promise(r => setTimeout(r, BUILD_FAILURE_DELAY));
            
            await exec.exec('7z', ['a', '-tzip', `${cachePath}\\artifacts.zip`, `${cachePath}\\src`, '-mx=3', '-mtc=on'], {
                ignoreReturnCode: true
            });
            
            const cacheSaved = await saveToCache([`${cachePath}\\artifacts.zip`], cacheKey);
            if (!cacheSaved) {
                console.warn('Failed to save cache after multiple attempts');
            }
            
            core.setOutput('finished', false);
        }
    } catch (error) {
        core.setFailed(error.message);
    }
}

run().catch(err => core.setFailed(err.message));
