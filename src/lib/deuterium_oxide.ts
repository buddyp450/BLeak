import {injectIntoHead, exposeClosureState} from './transformations';
import {IProxy, IBrowserDriver, Leak, ConfigurationFile, HeapSnapshot} from '../common/interfaces';
import HeapGrowthTracker from './growth_tracker';
import {GrowthPath} from './growth_graph';

const AGENT_INJECT = `<script src="text/javascript" src="/deuterium_agent.js"></script>`;

/**
 * Find leaks in an application.
 * @param configSource The source code of the configuration file, in UMD form.
 *   Should define global variable DeuteriumConfig.
 * @param proxy The proxy instance that relays connections from the webpage.
 * @param driver The application driver.
 */
export function FindLeaks(configSource: string, proxy: IProxy, driver: IBrowserDriver): Promise<Leak[]> {
  // TODO: Check shape of object, too.
  const CONFIG_INJECT = `
<script src="text/javascript">${configSource}
if (!window['DeuteriumConfig']) {
  console.error('Invalid configuration file: Global DeuteriumConfig object is not defined.');
}
</script>`;
  return new Promise((resolve, reject) => {
    new Function(configSource)();
    const config: ConfigurationFile = (<any> global).DeuteriumConfig;

    let diagnosing = false;
    proxy.onRequest((f) => {
      const mime = f.mimetype.toLowerCase();
      switch (mime) {
        case 'text/html':
          f.contents = injectIntoHead(f.contents, `${AGENT_INJECT}${CONFIG_INJECT}`);
          break;
        case 'text/javascript':
          if (diagnosing) {
            f.contents = exposeClosureState(f.contents);
          }
          break;
      }
      return f;
    });

    function wait(d: number): Promise<void> {
      return new Promise<void>((resolve) => {
        setTimeout(resolve, d);
      });
    }

    function takeSnapshot(): PromiseLike<HeapSnapshot> {
      return driver.takeHeapSnapshot();
    }

    function waitUntilTrue(i: number): PromiseLike<void> {
      return driver.runCode(`DeuteriumConfig.loop[${i}].check()`).then((success) => {
        if (!success) {
          return wait(1000).then(() => waitUntilTrue(i));
        } else {
          return undefined;
        }
      });
    }

    function nextStep(i: number): PromiseLike<string> {
      return waitUntilTrue(i).then(() => {
        return driver.runCode(`DeuteriumConfig.loop[${i}].next()`);
      });
    }

    function runLoop(snapshotAtEnd: false): PromiseLike<string>;
    function runLoop(snapshotAtEnd: true): PromiseLike<HeapSnapshot>;
    function runLoop(snapshotAtEnd: boolean): PromiseLike<HeapSnapshot | string> {
      const numSteps = config.loop.length;
      let promise = nextStep(0);
      if (numSteps > 1) {
        for (let i = 1; i < numSteps; i++) {
          promise = promise.then(() => nextStep(i));
        }
      }
      if (snapshotAtEnd) {
        return promise.then(takeSnapshot);
      }
      return promise;
    }

    let growthTracker = new HeapGrowthTracker();
    let growthPaths: GrowthPath[] = null;
    function processSnapshot(snapshot: HeapSnapshot): PromiseLike<void> {
      return new Promise<void>((res, rej) => {
        growthTracker.addSnapshot(snapshot);
        res();
      });
    }

    /**
     * Instruments the objects at the growth paths so they record stack traces whenever they expand.
     * @param ps
     */
    function instrumentGrowthPaths(ps: GrowthPath[]): PromiseLike<any> {
      return driver.runCode(`window.$$instrumentPaths(${JSON.stringify(ps.map((p) => p.getAccessString()))})`);
    }

    /**
     * Returns all of the stack traces associated with growing objects.
     */
    function getGrowthStacks(): PromiseLike<{[p: string]: {[prop: string]: string[]}}> {
      return driver.runCode(`window.$$getStackTraces()`).then((data) => JSON.parse(data));
    }

    driver.navigateTo(config.url).then(() => {
      // Capture 5 heap snapshots.
      let promise = runLoop(true).then(processSnapshot);
      for (let i = 0; i < 4; i++) {
        promise = promise.then(() => runLoop(true).then(processSnapshot));
      }
      // Instrument growing paths.
      promise = promise.then(() => {
        growthPaths = growthTracker.getGrowthPaths();
        // No more need for the growth tracker!
        growthTracker = null;
      }).then(() => {
        // We now have all needed closure modifications ready.
        // Run once.
        if (growthPaths.length > 0) {
          // Flip on JS instrumentation.
          diagnosing = true;
          return driver.navigateTo(config.url)
            .then(() => runLoop(false))
            .then(() => {
              // Instrument objects to push information to global array.
              return instrumentGrowthPaths(growthPaths);
            })
            // Measure growth during one more loop.
            .then(() => runLoop(false))
            .then(() => {
              // Fetch array as string.
              return getGrowthStacks().then((growthStacks) => {
                // Log to console for now.
                for (const p in growthStacks) {
                  // Log paths for now.
                  console.log(`${p} ${Object.keys(growthStacks[p]).length} properties`);
                }
              });
            });
        } else {
          return undefined;
        }
      });

      return promise;
    }).catch(reject);
  });
}

// Need communication path from webpage -> proxy in the shim.
// proxy.onmessage.

export default FindLeaks;