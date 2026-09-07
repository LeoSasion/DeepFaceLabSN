using System.IO;

namespace DeepFaceLabSN.Launcher
{
    internal static class WebUiDependencies
    {
        // esbuild belongs to Vite, so resolve it from Vite's dependency scope.
        // pnpm does not expose transitive dependencies at the project root.
        public const string ProbeScript =
            "let failed=false;"
            + "for(const name of ['node-pty','vite/esbuild']){try{"
            + "if(name==='node-pty'){require('node-pty')}else{"
            + "const r=require('node:module').createRequire(require.resolve('vite/package.json'));"
            + "r('esbuild').transformSync('let ready=true')}"
            + "console.log(name+': OK')"
            + "}catch(error){failed=true;console.error(name+': '+(error.stack||error))}}"
            + "if(failed)process.exitCode=1;";

        public static bool EntryPointsPresent(string projectRoot)
        {
            string modules = Path.Combine(projectRoot, "webui", "node_modules");
            return File.Exists(Path.Combine(modules, "vite", "bin", "vite.js"))
                && File.Exists(Path.Combine(modules, "node-pty", "package.json"));
        }
    }
}
