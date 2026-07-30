if __name__ == "__main__":
    # 取消注释以在 PDB 中启动 DFL
    # __spec__ = "ModuleSpec(name='builtins', loader=<class '_frozen_importlib.BuiltinImporter'>)"

    # 适用于 Linux 的修复
    import multiprocessing

    multiprocessing.set_start_method("spawn")

    from core.leras import nn

    nn.initialize_main_env()
    import os
    import sys
    import time
    import argparse

    from core import pathex
    from core import osex
    from pathlib import Path
    from core.interact import interact as io

    if sys.version_info[0] < 3 or (
        sys.version_info[0] == 3 and sys.version_info[1] < 6
    ):
        raise Exception("该程序至少需要 Python 3.6 版本")

    class fixPathAction(argparse.Action):
        def __call__(self, parser, namespace, values, option_string=None):
            setattr(namespace, self.dest, os.path.abspath(os.path.expanduser(values)))

    exit_code = 0

    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers()

    def process_extract(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import Extractor

        Extractor.main(
            detector=arguments.detector,
            extract_from_video=arguments.extract_from_video,
            input_video=Path(arguments.input_video)
            if arguments.input_video is not None
            else None,
            chunk_size=arguments.chunk_size,
            input_path=Path(arguments.input_dir),
            output_path=Path(arguments.output_dir),
            output_debug=arguments.output_debug,
            manual_fix=arguments.manual_fix,
            manual_output_debug_fix=arguments.manual_output_debug_fix,
            manual_window_size=arguments.manual_window_size,
            face_type=arguments.face_type,
            max_faces_from_image=arguments.max_faces_from_image,
            image_size=arguments.image_size,
            jpeg_quality=arguments.jpeg_quality,
            fps=arguments.fps,
            cpu_only=arguments.cpu_only,
            force_gpu_idxs=[int(x) for x in arguments.force_gpu_idxs.split(",")]
            if arguments.force_gpu_idxs is not None
            else None,
        )

    p = subparsers.add_parser("extract", help="从图片中提取人脸。")
    p.add_argument(
        "--detector",
        dest="detector",
        choices=["s3fd", "manual"],
        default=None,
        help="人脸框取检测器类型。",
    )
    p.add_argument(
        "--extract-from-video",
        dest="extract_from_video",
        action="store_true",
        default=False,
        help="直接从视频文件提取对齐图像",
    )
    p.add_argument(
        "--input-video",
        required=False,
        action=fixPathAction,
        dest="input_video",
        help="输入待处理的视频。指定 .*-扩展名 找到第一个满足的文件。",
    )
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="输入目录。包含您希望处理的文件的目录。",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        action=fixPathAction,
        dest="output_dir",
        help="输出目录。这是提取的切脸文件将被存储的地方。",
    )
    p.add_argument(
        "--output-debug",
        action="store_true",
        dest="output_debug",
        default=None,
        help="将 debug 图像写入 <output-dir>_debug\ 目录。",
    )
    p.add_argument(
        "--no-output-debug",
        action="store_false",
        dest="output_debug",
        default=None,
        help="不将 debug 图像写入 <output-dir>_debug\ 目录。",
    )
    p.add_argument(
        "--face-type",
        dest="face_type",
        choices=["half_face", "full_face", "whole_face", "head", "mark_only"],
        default=None,
    )
    p.add_argument(
        "--max-faces-from-image",
        type=int,
        dest="max_faces_from_image",
        default=None,
        help="每张图片最大提取的人脸数量。",
    )
    p.add_argument(
        "--image-size", type=int, dest="image_size", default=None, help="输出图像尺寸。"
    )
    p.add_argument(
        "--jpeg-quality", type=int, dest="jpeg_quality", default=None, help="Jpeg 质量。"
    )
    p.add_argument(
        "--fps", type=int, dest="fps", default=None, help="视频中每秒提取的帧数。0 - 完整 fps。"
    )
    p.add_argument(
        "--chunk-size",
        type=int,
        dest="chunk_size",
        default=None,
        help="启用从视频提取时，允许选择 DFL 可以在内存中保存的最大帧数",
    )
    p.add_argument(
        "--manual-fix",
        action="store_true",
        dest="manual_fix",
        default=False,
        help="启用手动仅提取未识别出人脸的帧。",
    )
    p.add_argument(
        "--manual-output-debug-fix",
        action="store_true",
        dest="manual_output_debug_fix",
        default=False,
        help="对从 [output_dir]_debug\ 目录删除的 input-dir 帧执行手动重新提取。",
    )
    p.add_argument(
        "--manual-window-size",
        type=int,
        dest="manual_window_size",
        default=1368,
        help="手动修复窗口大小。默认：1368。",
    )
    p.add_argument(
        "--cpu-only",
        action="store_true",
        dest="cpu_only",
        default=False,
        help="在 CPU 上提取。",
    )
    p.add_argument(
        "--force-gpu-idxs",
        dest="force_gpu_idxs",
        default=None,
        help="强制选择用逗号分隔的 GPU 索引。",
    )

    p.set_defaults(func=process_extract)

    # 定义提取过程的函数
    def process_sort(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import Sorter

        Sorter.main(
            input_path=Path(arguments.input_dir),
            sort_by_method=arguments.sort_by_method,
        )

    p = subparsers.add_parser("sort", help="S对目录中的人脸进行排序。")
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="输入目录。包含您希望处理的文件的目录。",
    )
    p.add_argument(
        "--by",
        dest="sort_by_method",
        default=None,
        choices=(
            "blur",
            "motion-blur",
            "face-yaw",
            "face-pitch",
            "face-source-rect-size",
            "hist",
            "hist-dissim",
            "brightness",
            "hue",
            "black",
            "origname",
            "oneface",
            "final",
            "final-fast",
            "absdiff",
        ),
        help="Method of sorting. 'origname' sort by original filename to recover original sequence.",
    )
    p.set_defaults(func=process_sort)

    # 定义工具处理函数
    def process_util(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import Util

        if arguments.add_landmarks_debug_images:
            Util.add_landmarks_debug_images(input_path=arguments.input_dir)

        if arguments.recover_original_aligned_filename:
            Util.recover_original_aligned_filename(input_path=arguments.input_dir)

        if arguments.save_faceset_metadata:
            Util.save_faceset_metadata_folder(input_path=arguments.input_dir)

        if arguments.restore_faceset_metadata:
            Util.restore_faceset_metadata_folder(input_path=arguments.input_dir)

        if arguments.pack_faceset:
            io.log_info("执行人脸数据集打包...\r\n")
            from samplelib import PackedFaceset

            PackedFaceset.pack(Path(arguments.input_dir), ext=arguments.archive_type)

        if arguments.unpack_faceset:
            io.log_info("执行人脸数据集解包...\r\n")
            from samplelib import PackedFaceset

            PackedFaceset.unpack(Path(arguments.input_dir))

        if arguments.export_faceset_mask:
            io.log_info("导出人脸数据集遮罩..\r\n")
            Util.export_faceset_mask(Path(arguments.input_dir))

    # 添加“util”子命令和帮助信息
    p = subparsers.add_parser("util", help="实用工具。")
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="输入目录。包含您希望处理的文件的目录。",
    )
    p.add_argument(
        "--add-landmarks-debug-images",
        action="store_true",
        dest="add_landmarks_debug_images",
        default=False,
        help="为对齐的人脸添加地标调试图像。",
    )
    p.add_argument(
        "--recover-original-aligned-filename",
        action="store_true",
        dest="recover_original_aligned_filename",
        default=False,
        help="恢复原始对齐文件名。",
    )
    p.add_argument(
        "--save-faceset-metadata",
        action="store_true",
        dest="save_faceset_metadata",
        default=False,
        help="将人脸数据集元数据保存到文件。",
    )
    p.add_argument(
        "--restore-faceset-metadata",
        action="store_true",
        dest="restore_faceset_metadata",
        default=False,
        help="从文件恢复人脸数据集元数据。使用时图像文件名必须与保存时相同。",
    )
    p.add_argument(
        "--pack-faceset",
        action="store_true",
        dest="pack_faceset",
        default=False,
        help="打包人脸数据集。",
    )
    p.add_argument(
        "--unpack-faceset",
        action="store_true",
        dest="unpack_faceset",
        default=False,
        help="解包人脸数据集。",
    )
    p.add_argument(
        "--export-faceset-mask",
        action="store_true",
        dest="export_faceset_mask",
        default=False,
        help="导出人脸数据集遮罩。",
    )
    p.add_argument(
        "--archive-type", dest="archive_type", choices=["zip", "pak"], default=None
    )

    p.set_defaults(func=process_util)

    # 定义训练处理函数
    def process_train(arguments):
        osex.set_process_lowest_prio()

        kwargs = {
            "model_class_name": arguments.model_name,
            "saved_models_path": Path(arguments.model_dir),
            "training_data_src_path": Path(arguments.training_data_src_dir),
            "training_data_dst_path": Path(arguments.training_data_dst_dir),
            "pretraining_data_path": Path(arguments.pretraining_data_dir)
            if arguments.pretraining_data_dir is not None
            else None,
            "pretrained_model_path": Path(arguments.pretrained_model_dir)
            if arguments.pretrained_model_dir is not None
            else None,
            "src_pak_name": arguments.src_pak_name,
            "dst_pak_name": arguments.dst_pak_name,
            "no_preview": arguments.no_preview,
            "force_model_name": arguments.force_model_name,
            "force_gpu_idxs": [int(x) for x in arguments.force_gpu_idxs.split(",")]
            if arguments.force_gpu_idxs is not None
            else None,
            "cpu_only": arguments.cpu_only,
            "silent_start": arguments.silent_start,
            "execute_programs": [[int(x[0]), x[1]] for x in arguments.execute_program],
            "debug": arguments.debug,
            "saving_time": arguments.saving_time,
            "tensorboard_dir": arguments.tensorboard_dir,
            "start_tensorboard": arguments.start_tensorboard,
            "flask_preview": arguments.flask_preview,
            "config_training_file": arguments.config_training_file,
            "auto_gen_config": arguments.auto_gen_config,
            "gen_snapshot": arguments.gen_snapshot,
            "reduce_clutter": arguments.reduce_clutter,
        }
        from mainscripts import Trainer

        Trainer.main(**kwargs)

    # 添加“train”子命令和帮助信息
    p = subparsers.add_parser("train", help="训练器")
    p.add_argument(
        "--training-data-src-dir",
        required=True,
        action=fixPathAction,
        dest="training_data_src_dir",
        help="提取的 SRC 人脸数据集的目录。",
    )
    p.add_argument(
        "--training-data-dst-dir",
        required=True,
        action=fixPathAction,
        dest="training_data_dst_dir",
        help="提取的 DST 人脸数据集的目录。",
    )
    p.add_argument(
        "--pretraining-data-dir",
        action=fixPathAction,
        dest="pretraining_data_dir",
        default=None,
        help="用于预训练模式的可选提取人脸数据集目录。",
    )
    p.add_argument(
        "--src-pak-name",
        required=False,
        dest="src_pak_name",
        type=str,
        default=None,
        help="要使用的 src 人脸数据集包的名称",
    )
    p.add_argument(
        "--dst-pak-name",
        required=False,
        dest="dst_pak_name",
        type=str,
        default=None,
        help="要使用的 dst 人脸数据集包的名称",
    )
    p.add_argument(
        "--pretrained-model-dir",
        action=fixPathAction,
        dest="pretrained_model_dir",
        default=None,
        help="预训练模型文件的可选目录。（目前仅适用于 Quick96）。",
    )
    p.add_argument(
        "--model-dir",
        required=True,
        action=fixPathAction,
        dest="model_dir",
        help="保存模型的目录。",
    )
    p.add_argument(
        "--model",
        required=True,
        dest="model_name",
        choices=pathex.get_all_dir_names_startswith(
            Path(__file__).parent / "models", "Model_"
        ),
        help="模型类名称。",
    )
    p.add_argument(
        "--debug", action="store_true", dest="debug", default=False, help="调试样本。"
    )
    p.add_argument(
        "--saving-time", type=int, dest="saving_time", default=25, help="模型保存间隔。"
    )
    p.add_argument(
        "--no-preview",
        action="store_true",
        dest="no_preview",
        default=False,
        help="禁用预览窗口。",
    )
    p.add_argument(
        "--force-model-name",
        dest="force_model_name",
        default=None,
        help="强制从 model/ 文件夹中选择模型名称。",
    )
    p.add_argument(
        "--cpu-only",
        action="store_true",
        dest="cpu_only",
        default=False,
        help="在 CPU 上训练。",
    )
    p.add_argument(
        "--force-gpu-idxs",
        dest="force_gpu_idxs",
        default=None,
        help="强制选择用逗号分隔的 GPU 索引。",
    )
    p.add_argument(
        "--silent-start",
        action="store_true",
        dest="silent_start",
        default=False,
        help="静默启动。自动选择最佳 GPU 和上次使用的模型。",
    )
    p.add_argument(
        "--tensorboard-logdir",
        action=fixPathAction,
        dest="tensorboard_dir",
        help="Tensorboard 输出文件的目录",
    )
    p.add_argument(
        "--start-tensorboard",
        action="store_true",
        dest="start_tensorboard",
        default=False,
        help="自动启动预配置到 tensorboard-logdir 的 tensorboard 服务器",
    )
    p.add_argument(
        "--config-training-file",
        action=fixPathAction,
        dest="config_training_file",
        help="自定义 yaml 配置文件的路径",
    )
    p.add_argument(
        "--auto-gen-config",
        action="store_true",
        dest="auto_gen_config",
        default=False,
        help="为训练器中使用的每个模型保存配置文件。它将具有相同的模型名称",
    )
    p.add_argument(
        "--reduce-clutter",
        action="store_true",
        dest="reduce_clutter",
        default=False,
        help="从打印的摘要中移除未使用的选项",
    )

    p.add_argument(
        "--gen-snapshot",
        action="store_true",
        dest="gen_snapshot",
        default=False,
        help="仅生成一组快照。",
    )
    p.add_argument(
        "--flask-preview",
        action="store_true",
        dest="flask_preview",
        default=False,
        help="启动一个 flask 服务器，在 web 浏览器中查看预览",
    )

    p.add_argument(
        "--execute-program",
        dest="execute_program",
        default=[],
        action="append",
        nargs="+",
    )
    p.set_defaults(func=process_train)

    # 定义 exportdfm 处理函数
    def process_exportdfm(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import ExportDFM

        ExportDFM.main(
            model_class_name=arguments.model_name,
            saved_models_path=Path(arguments.model_dir),
        )

    # 添加“exportdfm”子命令和帮助信息
    p = subparsers.add_parser("exportdfm", help="导出用于 DeepFaceLive 的模型。")
    p.add_argument(
        "--model-dir",
        required=True,
        action=fixPathAction,
        dest="model_dir",
        help="已保存模型的目录。",
    )
    p.add_argument(
        "--model",
        required=True,
        dest="model_name",
        choices=pathex.get_all_dir_names_startswith(
            Path(__file__).parent / "models", "Model_"
        ),
        help="模型类名称。",
    )
    p.set_defaults(func=process_exportdfm)

    # 定义 ampconverter 处理函数
    def process_ampconverter(arguments):
        from mainscripts import AmpConverter

        AmpConverter.main(saved_models_path=Path(arguments.model_dir))

    p = subparsers.add_parser("ampconverter", help="重命名模型文件以用于 AMPModel。仅适用于 AMP 模型。")
    p.add_argument(
        "--model-dir",
        required=True,
        action=fixPathAction,
        dest="model_dir",
        help="保存模型的目录。",
    )
    p.set_defaults(func=process_ampconverter)

    # 定义合并处理函数
    def process_merge(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import Merger

        Merger.main(
            model_class_name=arguments.model_name,
            saved_models_path=Path(arguments.model_dir),
            force_model_name=arguments.force_model_name,
            input_path=Path(arguments.input_dir),
            output_path=Path(arguments.output_dir),
            output_mask_path=Path(arguments.output_mask_dir),
            aligned_path=Path(arguments.aligned_dir)
            if arguments.aligned_dir is not None
            else None,
            pak_name=arguments.pak_name,
            force_gpu_idxs=[int(x) for x in arguments.force_gpu_idxs.split(",")]
            if arguments.force_gpu_idxs is not None
            else None,
            xseg_models_path=Path(arguments.xseg_dir),
            cpu_only=arguments.cpu_only,
        )

    # 添加“merge”子命令和帮助信息
    p = subparsers.add_parser("merge", help="合并器")
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="输入目录。包含您希望处理的文件的目录。",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        action=fixPathAction,
        dest="output_dir",
        help="输出目录。合并文件将被存储在此处。",
    )
    p.add_argument(
        "--output-mask-dir",
        required=True,
        action=fixPathAction,
        dest="output_mask_dir",
        help="输出掩码目录。掩码文件将被存储在此处。",
    )
    p.add_argument(
        "--aligned-dir",
        action=fixPathAction,
        dest="aligned_dir",
        default=None,
        help="对齐目录。这是存储提取的目标面部的位置。",
    )
    p.add_argument(
        "--pak-name",
        required=False,
        dest="pak_name",
        type=str,
        default=None,
        help="使用的人脸集包的名称",
    )
    p.add_argument(
        "--model-dir",
        required=True,
        action=fixPathAction,
        dest="model_dir",
        help="模型目录。",
    )
    p.add_argument(
        "--model",
        required=True,
        dest="model_name",
        choices=pathex.get_all_dir_names_startswith(
            Path(__file__).parent / "models", "Model_"
        ),
        help="模型类名称。",
    )
    p.add_argument(
        "--force-model-name",
        dest="force_model_name",
        default=None,
        help="强制从model/文件夹中选择模型名称。",
    )
    p.add_argument(
        "--cpu-only",
        action="store_true",
        dest="cpu_only",
        default=False,
        help="仅使用CPU合并。",
    )
    p.add_argument(
        "--force-gpu-idxs", dest="force_gpu_idxs", default=None, help="强制选择用逗号分隔的GPU索引。"
    )
    p.add_argument(
        "--reduce-clutter",
        action="store_true",
        dest="reduce_clutter",
        default=False,
        help="从打印的摘要中移除未使用的选项",
    )
    p.add_argument('--xseg-dir', required=True, action=fixPathAction, dest="xseg_dir", help="XSeg dir.")
    p.set_defaults(func=process_merge)

    videoed_parser = subparsers.add_parser("videoed", help="视频处理。").add_subparsers()

    def process_videoed_extract_video(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import VideoEd

        VideoEd.extract_video(
            arguments.input_file,
            arguments.output_dir,
            arguments.output_ext,
            arguments.fps,
        )

    p = videoed_parser.add_parser("extract-video", help="从视频文件提取图像。")
    p.add_argument(
        "--input-file",
        required=True,
        action=fixPathAction,
        dest="input_file",
        help="要处理的输入文件。指定.*-扩展名以查找第一个文件。",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        action=fixPathAction,
        dest="output_dir",
        help="输出目录。提取的图像将被存储在此处。",
    )
    p.add_argument(
        "--output-ext", dest="output_ext", default=None, help="输出文件的图像格式（扩展名）。"
    )
    p.add_argument(
        "--fps", type=int, dest="fps", default=None, help="每秒视频将被提取的帧数。0fps - 视频fps"
    )
    p.set_defaults(func=process_videoed_extract_video)

    def process_videoed_cut_video(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import VideoEd

        VideoEd.cut_video(
            arguments.input_file,
            arguments.from_time,
            arguments.to_time,
            arguments.audio_track_id,
            arguments.bitrate,
        )

    p = videoed_parser.add_parser("cut-video", help="剪切视频文件。")
    p.add_argument(
        "--input-file",
        required=True,
        action=fixPathAction,
        dest="input_file",
        help="要处理的输入文件。指定.*-扩展名以查找第一个文件。",
    )
    p.add_argument(
        "--from-time", dest="from_time", default=None, help="开始时间，例如 00:00:00.000"
    )
    p.add_argument(
        "--to-time", dest="to_time", default=None, help="结束时间，例如 00:00:00.000"
    )
    p.add_argument(
        "--audio-track-id",
        type=int,
        dest="audio_track_id",
        default=None,
        help="指定音轨ID。",
    )
    p.add_argument(
        "--bitrate", type=int, dest="bitrate", default=None, help="输出文件的比特率（兆比特）。"
    )
    p.set_defaults(func=process_videoed_cut_video)

    def process_videoed_denoise_image_sequence(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import VideoEd

        VideoEd.denoise_image_sequence(arguments.input_dir, arguments.factor)

    p = videoed_parser.add_parser(
        "denoise-image-sequence", help="对图像序列进行降噪，保持清晰的边缘。帮助去除预测面部的像素抖动。"
    )
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="要处理的输入目录。",
    )
    p.add_argument(
        "--factor", type=int, dest="factor", default=None, help="降噪因子（1-20）。"
    )
    p.set_defaults(func=process_videoed_denoise_image_sequence)

    def process_videoed_video_from_sequence(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import VideoEd

        VideoEd.video_from_sequence(
            input_dir=arguments.input_dir,
            output_file=arguments.output_file,
            reference_file=arguments.reference_file,
            ext=arguments.ext,
            fps=arguments.fps,
            bitrate=arguments.bitrate,
            include_audio=arguments.include_audio,
            lossless=arguments.lossless,
        )

    p = videoed_parser.add_parser("video-from-sequence", help="从图像序列制作视频。")
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="要处理的输入文件。指定.*-扩展名以查找第一个文件。",
    )
    p.add_argument(
        "--output-file",
        required=True,
        action=fixPathAction,
        dest="output_file",
        help="要处理的输入文件。指定.*-扩展名以查找第一个文件。",
    )
    p.add_argument(
        "--reference-file",
        action=fixPathAction,
        dest="reference_file",
        help="参考文件用于确定正确的FPS并从中传输音频。指定.*-扩展名以查找第一个文件。",
    )
    p.add_argument("--ext", dest="ext", default="png", help="输入文件的图像格式（扩展名）。")
    p.add_argument(
        "--fps", type=int, dest="fps", default=None, help="输出文件的FPS。会被参考文件覆盖。"
    )
    p.add_argument(
        "--bitrate", type=int, dest="bitrate", default=None, help="输出文件的比特率（兆比特）。"
    )
    p.add_argument(
        "--include-audio",
        action="store_true",
        dest="include_audio",
        default=False,
        help="包含参考文件的音频。",
    )
    p.add_argument(
        "--lossless",
        action="store_true",
        dest="lossless",
        default=False,
        help="无损PNG编码。",
    )

    p.set_defaults(func=process_videoed_video_from_sequence)

    facesettool_parser = subparsers.add_parser(
        "facesettool", help="人脸集工具。"
    ).add_subparsers()

    def process_faceset_enhancer(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import FacesetEnhancer

        FacesetEnhancer.process_folder(
            Path(arguments.input_dir),
            cpu_only=arguments.cpu_only,
            force_gpu_idxs=arguments.force_gpu_idxs,
        )

    p = facesettool_parser.add_parser("enhance", help="增强DFL人脸集中的细节。")
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="对齐人脸的输入目录。",
    )
    p.add_argument(
        "--cpu-only",
        action="store_true",
        dest="cpu_only",
        default=False,
        help="在CPU上处理。",
    )
    p.add_argument(
        "--force-gpu-idxs", dest="force_gpu_idxs", default=None, help="强制选择用逗号分隔的GPU索引。"
    )

    p.set_defaults(func=process_faceset_enhancer)

    p = facesettool_parser.add_parser("resize", help="调整DFL人脸集的大小。")
    p.add_argument(
        "--input-dir",
        required=True,
        action=fixPathAction,
        dest="input_dir",
        help="对齐人脸的输入目录。",
    )

    def process_faceset_resizer(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import FacesetResizer

        FacesetResizer.process_folder(Path(arguments.input_dir))

    p.set_defaults(func=process_faceset_resizer)

    def process_dev_test(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import dev_misc

        dev_misc.dev_test(arguments.input_dir)

    p = subparsers.add_parser("dev_test", help="开发测试")
    p.add_argument("--input-dir", required=True, action=fixPathAction, dest="input_dir")
    p.set_defaults(func=process_dev_test)

    # ========== XSeg
    xseg_parser = subparsers.add_parser("xseg", help="XSeg 工具。").add_subparsers()

    p = xseg_parser.add_parser("editor", help="XSeg 编辑器。")

    def process_xsegeditor(arguments):
        osex.set_process_lowest_prio()
        from XSegEditor import XSegEditor

        global exit_code
        exit_code = XSegEditor.start(Path(arguments.input_dir))

    p.add_argument("--input-dir", required=True, action=fixPathAction, dest="input_dir")

    p.set_defaults(func=process_xsegeditor)

    p = xseg_parser.add_parser("apply", help="将训练过的 XSeg 模型应用于提取的面部。")

    def process_xsegapply(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import XSegUtil

        XSegUtil.apply_xseg(Path(arguments.input_dir), Path(arguments.model_dir))

    p.add_argument("--input-dir", required=True, action=fixPathAction, dest="input_dir")
    p.add_argument("--model-dir", required=True, action=fixPathAction, dest="model_dir")
    p.set_defaults(func=process_xsegapply)

    p = xseg_parser.add_parser("remove", help="从提取的面部中移除应用的 XSeg 遮罩。")

    def process_xsegremove(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import XSegUtil

        XSegUtil.remove_xseg(Path(arguments.input_dir))

    p.add_argument("--input-dir", required=True, action=fixPathAction, dest="input_dir")
    p.set_defaults(func=process_xsegremove)

    p = xseg_parser.add_parser("remove_labels", help="从提取的面部中移除 XSeg 标签。")

    def process_xsegremovelabels(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import XSegUtil

        XSegUtil.remove_xseg_labels(Path(arguments.input_dir))

    p.add_argument("--input-dir", required=True, action=fixPathAction, dest="input_dir")
    p.set_defaults(func=process_xsegremovelabels)

    p = xseg_parser.add_parser("fetch", help="复制包含 XSeg 多边形的面部到 <input_dir>_xseg 目录。")

    def process_xsegfetch(arguments):
        osex.set_process_lowest_prio()
        from mainscripts import XSegUtil

        XSegUtil.fetch_xseg(Path(arguments.input_dir))

    p.add_argument("--input-dir", required=True, action=fixPathAction, dest="input_dir")
    p.set_defaults(func=process_xsegfetch)

    # dev
    def process_latents(arguments):
        osex.set_process_lowest_prio()

        kwargs = {
            "model_class_name": arguments.model_name,
            "saved_models_path": Path(arguments.model_dir),
            "file_one": Path(arguments.f1),
            "file_two": Path(arguments.f2),
        }

        from mainscripts import Latent

        Latent.main(**kwargs)

    p = subparsers.add_parser("latent")
    p.add_argument(
        "--model-dir",
        required=True,
        action=fixPathAction,
        dest="model_dir",
        help="模型目录。",
    )
    p.add_argument(
        "--model",
        required=True,
        dest="model_name",
        choices=pathex.get_all_dir_names_startswith(
            Path(__file__).parent / "models", "Model_"
        ),
        help="模型类名称。",
    )
    p.add_argument("--f1", required=True, action=fixPathAction, dest="f1", help="文件 1。")
    p.add_argument("--f2", required=True, action=fixPathAction, dest="f2", help="文件 2。")
    p.set_defaults(func=process_latents)

    def bad_args(arguments):
        parser.print_help()
        exit(0)

    parser.set_defaults(func=bad_args)

    from utils.logo import print_community_info

    print_community_info()

    arguments = parser.parse_args()
    arguments.func(arguments)

    if exit_code == 0:
        print("完成。")

    exit(exit_code)

"""
import code
code.interact(local=dict(globals(), **locals()))
"""
