const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const {DefaultArtifactClient} = require('@actions/artifact');
const github = require('@actions/github');
const glob = require('@actions/glob');

// Helper function to set artifact output
function setArtifactOutput(artifactId) {
    core.setOutput('artifact_id', artifactId ? String(artifactId) : '');
}

async function findArtifactFromPreviousRuns(artifactName) {
    // Use GitHub API to find artifact from previous workflow runs
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        console.log('No GITHUB_TOKEN available, cannot search previous runs');
        return null;
    }
    
    const octokit = github.getOctokit(token);
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    
    try {
        // List artifacts for the repository
        const { data } = await octokit.rest.actions.listArtifactsForRepo({
            owner,
            repo,
            name: artifactName,
            per_page: 10
        });
        
        if (data.artifacts && data.artifacts.length > 0) {
            // Get the most recent non-expired artifact
            const validArtifact = data.artifacts.find(a => !a.expired);
            if (validArtifact) {
                console.log(`Found artifact '${artifactName}' from run ${validArtifact.workflow_run.id} with ID: ${validArtifact.id}`);
                return {
                    id: validArtifact.id,
                    runId: validArtifact.workflow_run.id
                };
            }
        }
        console.log(`No valid artifact found with name '${artifactName}' in previous runs`);
        return null;
    } catch (e) {
        console.log(`Error searching for artifacts: ${e.message}`);
        return null;
    }
}

async function uploadBuildArtifact(artifact, artifactName) {
    await new Promise(r => setTimeout(r, 5000));
    await exec.exec('7z', ['a', '-tzip', 'C:\\ungoogled-chromium-windows\\artifacts.zip',
        'C:\\ungoogled-chromium-windows\\build\\src', '-mx=3', '-mtc=on'], {ignoreReturnCode: true});
    
    let uploadedArtifactId = null;
    for (let i = 0; i < 5; ++i) {
        try {
            await artifact.deleteArtifact(artifactName);
        } catch (e) {
            // ignored
        }
        try {
            const result = await artifact.uploadArtifact(artifactName, ['C:\\ungoogled-chromium-windows\\artifacts.zip'],
                'C:\\ungoogled-chromium-windows', {retentionDays: 1, compressionLevel: 0});
            uploadedArtifactId = result.id;
            console.log(`Uploaded build artifact with ID: ${uploadedArtifactId}`);
            break;
        } catch (e) {
            console.error(`Upload artifact failed: ${e}`);
            // Wait 10 seconds between the attempts
            await new Promise(r => setTimeout(r, 10000));
        }
    }
    return uploadedArtifactId;
}

async function run() {
    let artifactId = null;
    
    // Note: Signal handlers in Node.js actions have limited ability to perform async operations
    // The main error handling in the catch block handles artifact saving on failure
    process.on('SIGINT', function() {
        console.log('Received SIGINT signal');
    });
    
    process.on('SIGTERM', function() {
        console.log('Received SIGTERM signal');
    });

    const finished = core.getBooleanInput('finished', {required: true});
    const from_artifact = core.getBooleanInput('from_artifact', {required: true});
    const x86 = core.getBooleanInput('x86', {required: false});
    const arm = core.getBooleanInput('arm', {required: false});
    const simd = core.getInput('simd', {required: false}) || 'sse3';
    const inputArtifactId = core.getInput('artifact_id', {required: false});
    
    console.log(`finished: ${finished}, artifact: ${from_artifact}, simd: ${simd}, inputArtifactId: ${inputArtifactId}`);
    console.log(`=== Build Configuration ===`);
    console.log(`  Architecture: ${x86 ? 'x86' : (arm ? 'arm64' : 'x64')}`);
    console.log(`  SIMD Level: ${simd}`);
    console.log(`===========================`);
    
    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const artifact = new DefaultArtifactClient();
    // Include SIMD level in artifact name for x64 builds
    const archSuffix = x86 ? 'x86' : (arm ? 'arm' : `x64-${simd}`);
    const artifactName = `build-artifact-${archSuffix}`;
    console.log(`Using artifact name: ${artifactName}`);

    if (from_artifact) {
        try {
            let downloadArtifactId = null;
            
            // If a specific artifact ID was provided, validate and use it
            if (inputArtifactId && inputArtifactId.trim() !== '') {
                const parsedId = parseInt(inputArtifactId.trim(), 10);
                if (isNaN(parsedId) || parsedId <= 0) {
                    console.log(`Invalid artifact ID provided: '${inputArtifactId}'. Must be a positive integer. Starting fresh build.`);
                } else {
                    downloadArtifactId = parsedId;
                    console.log(`Using provided artifact ID: ${downloadArtifactId}`);
                }
            } else {
                // Try to find the artifact by name in current run first
                try {
                    const artifactInfo = await artifact.getArtifact(artifactName);
                    downloadArtifactId = artifactInfo.artifact.id;
                    console.log(`Found artifact in current run with ID: ${downloadArtifactId}`);
                } catch (e) {
                    console.log(`No artifact found in current run, searching previous runs...`);
                    // Try to find artifact from previous workflow runs
                    const previousArtifact = await findArtifactFromPreviousRuns(artifactName);
                    if (previousArtifact) {
                        downloadArtifactId = previousArtifact.id;
                        console.log(`Will download artifact from previous run ${previousArtifact.runId}`);
                    } else {
                        console.log(`No existing artifact found by name '${artifactName}', starting fresh build`);
                    }
                }
            }
            
            if (downloadArtifactId) {
                console.log(`Downloading artifact ID: ${downloadArtifactId}`);
                await artifact.downloadArtifact(downloadArtifactId, {path: 'C:\\ungoogled-chromium-windows\\build'});
                await exec.exec('7z', ['x', 'C:\\ungoogled-chromium-windows\\build\\artifacts.zip',
                    '-oC:\\ungoogled-chromium-windows\\build', '-y']);
                await io.rmRF('C:\\ungoogled-chromium-windows\\build\\artifacts.zip');
            }
        } catch (e) {
            console.log(`Failed to download artifact: ${e.message}. Starting fresh build.`);
        }
    }

    const args = ['build.py', '--ci', '-j', '2', '--simd', simd];
    if (x86)
        args.push('--x86');
    if (arm)
        args.push('--arm');
    
    await exec.exec('python', ['-m', 'pip', 'install', 'httplib2==0.22.0'], {
        cwd: 'C:\\ungoogled-chromium-windows',
        ignoreReturnCode: true
    });
    
    let retCode;
    try {
        retCode = await exec.exec('python', args, {
            cwd: 'C:\\ungoogled-chromium-windows',
            ignoreReturnCode: true
        });
    } catch (e) {
        // Build process was interrupted or failed - save artifacts for retry
        console.log(`Build process interrupted or failed: ${e.message}`);
        console.log('Saving build artifacts for retry...');
        artifactId = await uploadBuildArtifact(artifact, artifactName);
        core.setOutput('finished', false);
        setArtifactOutput(artifactId);
        throw e;
    }
    
    if (retCode === 0) {
        core.setOutput('finished', true);
        const globber = await glob.create('C:\\ungoogled-chromium-windows\\build\\ungoogled-chromium*',
            {matchDirectories: false});
        let packageList = await globber.glob();
        const finalArtifactName = x86 ? 'chromium-x86' : (arm ? 'chromium-arm' : `chromium-x64-${simd}`);
        console.log(`Uploading final artifact: ${finalArtifactName}`);
        for (let i = 0; i < 5; ++i) {
            try {
                await artifact.deleteArtifact(finalArtifactName);
            } catch (e) {
                // ignored
            }
            try {
                const result = await artifact.uploadArtifact(finalArtifactName, packageList,
                    'C:\\ungoogled-chromium-windows\\build', {retentionDays: 3, compressionLevel: 0});
                console.log(`Uploaded final artifact with ID: ${result.id}`);
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                // Wait 10 seconds between the attempts
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    } else {
        // Build didn't complete - save artifacts for retry
        console.log('Build did not complete, saving artifacts for retry...');
        artifactId = await uploadBuildArtifact(artifact, artifactName);
        core.setOutput('finished', false);
        setArtifactOutput(artifactId);
    }
}

run().catch(async err => {
    // On any error, try to save artifacts before failing
    console.error(`Build failed with error: ${err.message}`);
    console.log('Attempting to save artifacts before failing...');
    
    try {
        const x86 = core.getBooleanInput('x86', {required: false});
        const arm = core.getBooleanInput('arm', {required: false});
        const simd = core.getInput('simd', {required: false}) || 'sse3';
        const artifact = new DefaultArtifactClient();
        const archSuffix = x86 ? 'x86' : (arm ? 'arm' : `x64-${simd}`);
        const artifactName = `build-artifact-${archSuffix}`;
        
        const artifactId = await uploadBuildArtifact(artifact, artifactName);
        setArtifactOutput(artifactId);
        console.log(`Saved recovery artifact. Use artifact_id: ${artifactId} to resume build.`);
    } catch (uploadErr) {
        console.error(`Failed to save recovery artifact: ${uploadErr.message}`);
    }
    
    core.setFailed(err.message);
});
