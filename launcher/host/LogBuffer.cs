using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace DeepFaceLabSN.Launcher
{
    internal sealed class LogEntry
    {
        public long Sequence { get; set; }
        public string Timestamp { get; set; }
        public string Channel { get; set; }
        public string Line { get; set; }
        public string Level { get; set; }
    }

    internal sealed class LogSnapshot
    {
        public IList<LogEntry> Entries { get; set; }
        public long NextSequence { get; set; }
    }

    internal sealed class LogBuffer
    {
        private const int Capacity = 2000;
        private readonly object gate = new object();
        private readonly List<LogEntry> entries = new List<LogEntry>();
        private long nextSequence = 1;
        private readonly string session = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        private readonly string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepFaceLabSN", "Launcher", "logs");
        public string DirectoryPath { get; private set; }

        public LogBuffer()
        {
            SetDirectory(fallback);
        }

        public void SetDirectory(string directory)
        {
            lock (gate)
            {
                string target = Path.GetFullPath(directory);
                if (String.Equals(target, DirectoryPath, StringComparison.OrdinalIgnoreCase)) return;
                Directory.CreateDirectory(target);
                foreach (string suffix in new[] { ".log", ".errors.log" })
                {
                    string destination = Path.Combine(target, session + suffix);
                    if (DirectoryPath == null) File.WriteAllText(destination, String.Empty, new UTF8Encoding(false));
                    else File.Copy(Path.Combine(DirectoryPath, session + suffix), destination, true);
                }
                DirectoryPath = target;
            }
        }

        private void Persist(LogEntry entry)
        {
            string text = entry.Timestamp + " [" + entry.Level + "] [" + entry.Channel + "] " + entry.Line + Environment.NewLine;
            File.AppendAllText(Path.Combine(DirectoryPath, session + ".log"), text, new UTF8Encoding(false));
            if (String.Equals(entry.Level, "error", StringComparison.OrdinalIgnoreCase))
                File.AppendAllText(Path.Combine(DirectoryPath, session + ".errors.log"), text, new UTF8Encoding(false));
        }

        public event Action<LogEntry> EntryAdded;

        public void Add(string channel, string line, string level)
        {
            if (String.IsNullOrWhiteSpace(line))
            {
                return;
            }

            LogEntry entry;
            lock (gate)
            {
                entry = new LogEntry
                {
                    Sequence = nextSequence++,
                    Timestamp = DateTime.UtcNow.ToString("o"),
                    Channel = String.IsNullOrWhiteSpace(channel) ? "launcher" : channel,
                    Line = line.TrimEnd('\r', '\n'),
                    Level = String.IsNullOrWhiteSpace(level) ? "info" : level
                };
                try { Persist(entry); }
                catch (Exception error)
                {
                    // Keep the UI alive and make a project disk failure visible.
                    DirectoryPath = fallback;
                    Directory.CreateDirectory(fallback);
                    entry.Line = "日志写入失败，已回退至 " + fallback + "：" + error.Message + Environment.NewLine + entry.Line;
                    entry.Level = "error";
                    Persist(entry);
                }
                entries.Add(entry);
                if (entries.Count > Capacity)
                {
                    entries.RemoveRange(0, entries.Count - Capacity);
                }
            }

            Action<LogEntry> handler = EntryAdded;
            if (handler != null)
            {
                handler(entry);
            }
        }

        public LogSnapshot ReadSince(long sequence, int limit)
        {
            if (limit < 1)
            {
                limit = 200;
            }
            if (limit > 1000)
            {
                limit = 1000;
            }

            List<LogEntry> result = new List<LogEntry>();
            lock (gate)
            {
                for (int index = 0; index < entries.Count && result.Count < limit; index++)
                {
                    if (entries[index].Sequence > sequence)
                    {
                        result.Add(entries[index]);
                    }
                }
                return new LogSnapshot
                {
                    Entries = result,
                    NextSequence = result.Count == 0 ? sequence : result[result.Count - 1].Sequence
                };
            }
        }
    }
}
