const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const glob = require('@actions/glob');

async function run() {
    process.on('SIGINT', function() {});
    const finished = core.getBooleanInput('finished', { required: true });
    const from_cache = core.getBooleanInput('from_cache', { required: true });
    const x86 = core.getBooleanInput('x86', { required: false });
    console.log(`finished: ${finished}, from cache: ${from_cache}`);
    
    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const cacheKey = x86 ? 'build-cache-x86' : 'build-cache';
    const cachePath = 'C:\\ungoogled-chromium-windows\\build';

    if (from_cache) {
        // Try to restore the cache
        const restoredCacheKey = await cache.restoreCache([cachePath], cacheKey);
        if (restoredCacheKey) {
            console.log(`Cache restored from key: ${restoredCacheKey}`);
            await exec.exec('7z', ['x', `${cachePath}\\artifacts.zip`, `-o${cachePath}`, '-y']);
            await io.rmRF(`${cachePath}\\artifacts.zip`);
        } else {
            console.log('No cache found, proceeding without cache');
        }
    }

    const args = ['build.py', '--ci'];
    if (x86) args.push('--x86');

    await exec.exec('python', ['-m', 'pip', 'install', 'httplib2'], {
        cwd: 'C:\\ungoogled-chromium-windows',
        ignoreReturnCode: true
    });
    const retCode = await exec.exec('python', args, {
        cwd: 'C:\\ungoogled-chromium-windows',
        ignoreReturnCode: true
    });

    if (retCode === 0) {
        core.setOutput('finished', true);
        const globber = await glob.create('C:\\ungoogled-chromium-windows\\build\\ungoogled-chromium*', {
            matchDirectories: false
        });
        let packageList = await globber.glob();
        for (let i = 0; i < 5; ++i) {
            try {
                // Save the build files to cache
                await cache.saveCache(packageList, cacheKey);
                break;
            } catch (e) {
                console.error(`Cache save failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    } else {
        await new Promise(r => setTimeout(r, 5000));
        await exec.exec('7z', ['a', '-tzip', `${cachePath}\\artifacts.zip`, `${cachePath}\\src`, '-mx=3', '-mtc=on'], {
            ignoreReturnCode: true
        });
        for (let i = 0; i < 5; ++i) {
            try {
                // Save the failed build state to cache
                await cache.saveCache([`${cachePath}\\artifacts.zip`], cacheKey);
                break;
            } catch (e) {
                console.error(`Cache save failed: ${e}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
        core.setOutput('finished', false);
    }
}

run().catch(err => core.setFailed(err.message));
