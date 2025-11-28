const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const { DefaultArtifactClient } = require('@actions/artifact');
const glob = require('@actions/glob');
const path = require('path');

async function run() {
    process.on('SIGINT', function() {});

    const finished = core.getBooleanInput('finished', { required: true });
    const from_artifact = core.getBooleanInput('from_artifact', { required: true });
    const stage_index = parseInt(core.getInput('stage_index', { required: true }));
    const x86 = core.getBooleanInput('x86', { required: false });
    const arm = core.getBooleanInput('arm', { required: false });

    const archSuffix = x86 ? '-x86' : (arm ? '-arm' : '');
    const prevArtifactName = `build-artifact${archSuffix}-${stage_index - 1}`;
    const currentArtifactName = `build-artifact${archSuffix}-${stage_index}`;
    const finalArtifactName = `chromium${archSuffix}`;

    console.log(`[Stage ${stage_index}] Arch: ${archSuffix || 'x64'} | Resume Mode: ${from_artifact}`);

    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const artifact = new DefaultArtifactClient();
    const buildRoot = 'C:\\ungoogled-chromium-windows';
    const buildDir = path.join(buildRoot, 'build');

    try {
        // --- 1. RESTORE LOGIC ---
        if (from_artifact && stage_index > 1) {
            console.log(`Downloading artifact: ${prevArtifactName}`);
            try {
                const artifactInfo = await artifact.getArtifact(prevArtifactName);
                await artifact.downloadArtifact(artifactInfo.artifact.id, { path: buildDir });
                await exec.exec('7z', ['x', path.join(buildDir, 'artifacts.zip'), `-o${buildDir}`, '-y']);
                await io.rmRF(path.join(buildDir, 'artifacts.zip'));
            } catch (err) {
                throw new Error(`Failed to restore ${prevArtifactName}: ${err.message}`);
            }
        }

        // --- 2. PREPARE ---
        const args = ['build.py', '--ci', '-j', '2'];
        if (x86) args.push('--x86');
        if (arm) args.push('--arm');
        const env = { ...process.env };

        await exec.exec('python', ['-m', 'pip', 'install', 'httplib2==0.22.0'], {
            cwd: buildRoot,
            ignoreReturnCode: true
        });

        // --- 3. EXECUTE ---
        const retCode = await exec.exec('python', args, {
            cwd: buildRoot,
            ignoreReturnCode: true,
            env: env
        });

        // --- 4. OUTPUT ---
        if (retCode === 0) {
            core.setOutput('finished', true);
            const globber = await glob.create(path.join(buildDir, 'ungoogled-chromium*'), { matchDirectories: false });
            let packageList = await globber.glob();
            await uploadArtifactRetry(artifact, finalArtifactName, packageList, buildDir);
        } else {
            console.log(`Stage ${stage_index} incomplete. Saving state...`);
            await zipAndUpload(artifact, currentArtifactName, buildRoot, buildDir);
            core.setOutput('finished', false);
        }
    } catch (error) {
        console.error(`Stage ${stage_index} CRASHED: ${error.message}`);
        await zipAndUpload(artifact, currentArtifactName, buildRoot, buildDir);
        core.setFailed(error.message);
    }
}

async function zipAndUpload(artifactClient, name, buildRoot, buildDir) {
    await new Promise(r => setTimeout(r, 5000));
    const zipPath = path.join(buildRoot, 'artifacts.zip');
    await io.rmRF(zipPath); 
    await exec.exec('7z', ['a', '-tzip', zipPath, path.join(buildDir, 'src'), '-mx=3', '-mtc=on'], { ignoreReturnCode: true });
    await uploadArtifactRetry(artifactClient, name, [zipPath], buildRoot);
}

async function uploadArtifactRetry(artifactClient, name, files, rootDir) {
    if (!files || files.length === 0) return;
    for (let i = 0; i < 5; ++i) {
        try {
            await artifactClient.uploadArtifact(name, files, rootDir, { retentionDays: 5, compressionLevel: 0 });
            console.log(`Successfully uploaded ${name}`);
            return;
        } catch (e) {
            console.error(`Upload attempt ${i+1} failed: ${e.message}`);
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

run().catch(err => core.setFailed(err.message));