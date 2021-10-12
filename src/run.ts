import { setFailed } from '@actions/core';
import { context, getOctokit } from '@actions/github';

import { createCoverageAnnotations } from './annotations/createCoverageAnnotations';
import { createFailedTestsAnnotations } from './annotations/createFailedTestsAnnotations';
import { formatCoverageAnnotations } from './format/annotations/formatCoverageAnnotations';
import { formatFailedTestsAnnotations } from './format/annotations/formatFailedTestsAnnotations';
import { generateCommitReport } from './report/generateCommitReport';
import { generatePRReport } from './report/generatePRReport';
import { createReport } from './stages/createReport';
import { getCoverage } from './stages/getCoverage';
import { switchBranch } from './stages/switchBranch';
import { JsonReport } from './typings/JsonReport';
import { getOptions, shouldRunTestScript } from './typings/Options';
import { createDataCollector } from './utils/DataCollector';
import { getConsoleLink } from './utils/getConsoleLink';
import { i18n } from './utils/i18n';
import { runStage } from './utils/runStage';

export const run = async (
    dataCollector = createDataCollector<JsonReport>()
) => {
    const isInPR = context.eventName === 'pull_request';

    const [isInitialized, options] = await runStage(
        'initialize',
        dataCollector,
        getOptions
    );

    if (!isInitialized || !options) {
        throw Error('Initialization failed.');
    }

    const [isHeadCoverageGenerated, headCoverage] = await runStage(
        'headCoverage',
        dataCollector,
        async () => {
            return await getCoverage(
                dataCollector,
                options,
                options.coverageFile
            );
        }
    );

    if (headCoverage) {
        dataCollector.add(headCoverage);
    }

    let isSwitched = true;

    if (
        !options.baseCoverageFile &&
        shouldRunTestScript(options.skipStep)
    ) {
        console.log("switching to base");
        ([isSwitched] = await runStage(
            'switchToBase',
            dataCollector,
            async (skip) => {
                const baseBranch = context.payload.pull_request?.base.ref;
    
                if (!isInPR || !baseBranch) {
                    skip();
                }
    
                await switchBranch(baseBranch);
            }
        ));
    } else {
        console.log("Staying on branch");
    }

    const ignoreCollector = createDataCollector<JsonReport>();

    const [, baseCoverage] = await runStage(
        'baseCoverage',
        dataCollector,
        async (skip) => {
            if (!isSwitched) {
                skip();
            }

            return await getCoverage(
                ignoreCollector,
                options,
                options.baseCoverageFile
            );
        }
    );

    console.log("adding base coverage")
    if (baseCoverage) {
        dataCollector.add(baseCoverage);
    }

    console.log("base coverage added")
    if (dataCollector.get().errors.length > 0) {
        console.log("failing after base coverage")
        console.log(dataCollector.get().errors);
    }


    const [isReportContentGenerated, summaryReport] = await runStage(
        'generateReportContent',
        dataCollector,
        async () => {
            return createReport(dataCollector, options);
        }
    );

    console.log("report created")
    if (dataCollector.get().errors.length > 0) {
        console.log("failing after report created")
        console.log(dataCollector.get().errors);
    }

    await runStage('publishReport', dataCollector, async (skip) => {
        if (!isReportContentGenerated) {
            skip();
        }

        const octokit = getOctokit(options.token);

        if (isInPR) {
            await generatePRReport(
                summaryReport!.text,
                options,
                context.repo,
                context.payload.pull_request!,
                octokit
            );
        } else {
            await generateCommitReport(
                summaryReport!.text,
                context.repo,
                octokit
            );
        }
    });

    console.log("report published");
    if (dataCollector.get().errors.length > 0) {
        console.log("failing after report publishing")
        console.log(dataCollector.get().errors);
    }

    await runStage('failedTestsAnnotations', dataCollector, async (skip) => {
        if (
            !isHeadCoverageGenerated ||
            !['all', 'failed-tests'].includes(options.annotations)
        ) {
            skip();
        }

        const failedAnnotations = createFailedTestsAnnotations(headCoverage!);

        if (failedAnnotations.length === 0) {
            skip();
        }

        const octokit = getOctokit(options.token);
        await octokit.checks.create(
            formatFailedTestsAnnotations(
                summaryReport!.runReport,
                failedAnnotations
            )
        );
    });

    console.log("failed test annotations")
    if (dataCollector.get().errors.length > 0) {
        console.log("failing after test annotations")
        console.log(dataCollector.get().errors);
    }

    await runStage('coverageAnnotations', dataCollector, async (skip) => {
        if (
            !isHeadCoverageGenerated ||
            !['all', 'coverage'].includes(options.annotations)
        ) {
            skip();
        }

        const coverageAnnotations = createCoverageAnnotations(headCoverage!);

        if (coverageAnnotations.length === 0) {
            skip();
        }

        const octokit = getOctokit(options.token);
        await octokit.checks.create(
            formatCoverageAnnotations(coverageAnnotations)
        );
    });

    console.log("coverage annotations")

    if (dataCollector.get().errors.length > 0) {
        console.log(dataCollector.get().errors);
        setFailed(i18n('failed'));
    }
};
