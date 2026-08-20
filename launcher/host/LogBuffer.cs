using System;
using System.Collections.Generic;

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
