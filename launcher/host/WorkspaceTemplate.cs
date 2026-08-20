using System;
using System.Collections.Generic;
using System.IO;

namespace DeepFaceLabSN.Launcher
{
    internal static class WorkspaceTemplate
    {
        private static readonly string[] DirectoryNames =
        {
            "data_src",
            "data_dst",
            "model",
            "xseg_model",
            "pretrain_faces"
        };

        public static IList<string> Ensure(string projectRoot)
        {
            if (String.IsNullOrWhiteSpace(projectRoot))
            {
                throw new ArgumentNullException("projectRoot");
            }

            string root = Path.GetFullPath(projectRoot).TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            string workspace = Path.GetFullPath(Path.Combine(root, "workspace"));
            if (!workspace.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("工作区模板路径越界。");
            }
            if (File.Exists(workspace))
            {
                throw new IOException("workspace 路径被同名文件占用。");
            }

            List<string> created = new List<string>();
            if (!Directory.Exists(workspace))
            {
                Directory.CreateDirectory(workspace);
                created.Add("workspace");
            }
            DirectoryInfo workspaceInfo = new DirectoryInfo(workspace);
            if ((workspaceInfo.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException("为避免写入项目目录之外，启动器不会修改重解析点 workspace。");
            }

            for (int index = 0; index < DirectoryNames.Length; index++)
            {
                string name = DirectoryNames[index];
                string target = Path.Combine(workspace, name);
                if (File.Exists(target))
                {
                    throw new IOException("工作区模板目录被同名文件占用：workspace\\" + name);
                }
                if (!Directory.Exists(target))
                {
                    Directory.CreateDirectory(target);
                    created.Add("workspace\\" + name);
                }
            }
            return created;
        }
    }
}
