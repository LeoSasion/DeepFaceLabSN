using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class LauncherSettings
    {
        public string ProjectRoot { get; set; }
        public string Mirror { get; set; }
        public string LastCheck { get; set; }
        public string GitPath { get; set; }
        public string GitProxyMode { get; set; }
        public string GitProxy { get; set; }
        public string GitMirror { get; set; }

        public LauncherSettings()
        {
            Mirror = "auto";
            GitProxyMode = "auto";
        }
    }

    internal sealed class SettingsStore
    {
        private readonly object gate = new object();
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly string settingsPath;
        private LauncherSettings current;

        public SettingsStore()
        {
            settingsPath = Path.Combine(LauncherConstants.SettingsDirectory, "settings.json");
            current = Load();
        }

        public LauncherSettings Current
        {
            get
            {
                lock (gate)
                {
                    return Clone(current);
                }
            }
        }

        public string SettingsPath
        {
            get { return settingsPath; }
        }

        public void Update(Action<LauncherSettings> update)
        {
            if (update == null)
            {
                throw new ArgumentNullException("update");
            }

            lock (gate)
            {
                update(current);
                Save(current);
            }
        }

        private LauncherSettings Load()
        {
            try
            {
                if (!File.Exists(settingsPath))
                {
                    return new LauncherSettings();
                }

                string json = File.ReadAllText(settingsPath, Encoding.UTF8);
                LauncherSettings value = serializer.Deserialize<LauncherSettings>(json);
                if (value == null)
                {
                    return new LauncherSettings();
                }
                if (String.IsNullOrWhiteSpace(value.Mirror))
                {
                    value.Mirror = "auto";
                }
                value.GitProxyMode = GitNetworkOptions.NormalizeProxyMode(value.GitProxyMode);
                Dictionary<string, object> raw = serializer.DeserializeObject(json) as Dictionary<string, object>;
                if (ContainsKeyIgnoreCase(raw, "TerminalUrl"))
                {
                    Save(value);
                }
                return value;
            }
            catch
            {
                return new LauncherSettings();
            }
        }

        private void Save(LauncherSettings value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(settingsPath));
            string temporaryPath = settingsPath + ".tmp";
            string json = serializer.Serialize(value);
            File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));

            if (File.Exists(settingsPath))
            {
                string backupPath = settingsPath + ".bak";
                try
                {
                    File.Replace(temporaryPath, settingsPath, backupPath, true);
                    TryDelete(backupPath);
                    return;
                }
                catch
                {
                    TryDelete(settingsPath);
                }
            }

            File.Move(temporaryPath, settingsPath);
        }

        private static void TryDelete(string path)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch
            {
            }
        }

        private static bool ContainsKeyIgnoreCase(Dictionary<string, object> values, string expected)
        {
            if (values == null)
            {
                return false;
            }
            foreach (string key in values.Keys)
            {
                if (String.Equals(key, expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
            return false;
        }

        private static LauncherSettings Clone(LauncherSettings source)
        {
            return new LauncherSettings
            {
                ProjectRoot = source.ProjectRoot,
                Mirror = source.Mirror,
                LastCheck = source.LastCheck,
                GitPath = source.GitPath,
                GitProxyMode = source.GitProxyMode,
                GitProxy = source.GitProxy,
                GitMirror = source.GitMirror
            };
        }
    }
}
