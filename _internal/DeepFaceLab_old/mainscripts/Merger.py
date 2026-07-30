import math
import multiprocessing
import json
import os
import traceback
from pathlib import Path

import numpy as np
import numpy.linalg as npla

import samplelib
from core import pathex
from core.cv2ex import *
from core.interact import interact as io
from core.joblib import MPClassFuncOnDemand, MPFunc
from core.leras import nn
from DFLIMG import DFLIMG
from facelib import FaceEnhancer, FaceType, LandmarksProcessor, XSegNet
from merger import FrameInfo, InteractiveMergerSubprocessor, MergerConfig


def main (model_class_name=None,           # 定义主函数，可选参数包括模型类名称、保存模型的路径等
          saved_models_path=None,          # 保存模型的路径
          training_data_src_path=None,     # 训练数据的源路径
          force_model_name=None,           # 强制使用的模型名称
          input_path=None,                 # 输入路径
          output_path=None,                # 输出路径
          output_mask_path=None,           # 输出遮罩路径
          aligned_path=None,               # Aligned路径
          force_gpu_idxs=None,             # 强制使用的GPU索引
          xseg_models_path=None,           # XSeg路径
          cpu_only=None):                  # 是否仅使用CPU
    io.log_info ("正在准备 合成器.\r\n")    # 日志信息：正在准备合成器

    try:
        if not input_path.exists():        # 检查输入路径是否存在
            io.log_err('没有找到输入目录（默认%WORKSPACE%\data_dst），请确保它存在') # 如果不存在，输出错误信息
            return

        if not output_path.exists():       # 检查输出路径是否存在
            output_path.mkdir(parents=True, exist_ok=True) # 如果不存在，创建输出路径

        if not output_mask_path.exists():  # 检查输出遮罩路径是否存在
            output_mask_path.mkdir(parents=True, exist_ok=True) # 如果不存在，创建输出遮罩路径

        if not saved_models_path.exists(): # 检查模型保存路径是否存在
            io.log_err('没有找到模型目录（默认%WORKSPACE%\model），请确保它存在') # 如果不存在，输出错误信息
            return

        # Initialize model
        import models                       # 导入模型
        model = models.import_model(model_class_name)(is_training=False,  # 初始化模型
                                                      saved_models_path=saved_models_path,
                                                      force_gpu_idxs=force_gpu_idxs,
                                                      force_model_name=force_model_name,
                                                      cpu_only=cpu_only)

        predictor_func, predictor_input_shape, cfg = model.get_MergerConfig()  # 获取合并配置

        # Preparing MP functions
        predictor_func = MPFunc(predictor_func)  # 准备多进程函数

        run_on_cpu = len(nn.getCurrentDeviceConfig().devices) == 0  # 判断是否在CPU上运行
        xseg_256_extract_func = MPClassFuncOnDemand(XSegNet, 'extract',  # XSeg抠图功能
                                                    name='XSeg',
                                                    resolution=256,
                                                    weights_file_root=xseg_models_path,
                                                    place_model_on_cpu=True,
                                                    run_on_cpu=run_on_cpu)

        face_enhancer_func = MPClassFuncOnDemand(FaceEnhancer, 'enhance',  # 面部增强功能
                                                    place_model_on_cpu=True,
                                                    run_on_cpu=run_on_cpu)

        web_merge_config = None
        web_merge_config_raw = os.environ.get("DFL_WEB_MERGE_CONFIG", "").strip()
        if web_merge_config_raw:
            try:
                web_merge_config = json.loads(web_merge_config_raw)
            except Exception as error:
                raise ValueError(f"DFL_WEB_MERGE_CONFIG 无效: {error}")

        if web_merge_config is not None:
            is_interactive = False
            color_transfer_modes = {
                "none": 0, "rct": 1, "lct": 2, "mkl": 3, "mkl-m": 4,
                "idt": 5, "idt-m": 6, "sot-m": 7, "mix-m": 8,
            }
            if hasattr(cfg, "mode"):
                cfg.mode = str(web_merge_config.get("mode", "overlay"))
            if hasattr(cfg, "mask_mode"):
                cfg.mask_mode = int(np.clip(web_merge_config.get("maskMode", 7), 1, 9))
                cfg.erode_mask_modifier = int(np.clip(web_merge_config.get("erodeMask", 0), -400, 400))
                cfg.blur_mask_modifier = int(np.clip(web_merge_config.get("blurMask", 0), 0, 400))
                cfg.motion_blur_power = int(np.clip(web_merge_config.get("motionBlur", 0), 0, 100))
                cfg.output_face_scale = int(np.clip(web_merge_config.get("faceScale", 0), -50, 50))
                cfg.color_transfer_mode = color_transfer_modes.get(
                    str(web_merge_config.get("colorTransfer", "none")),
                    0,
                )
                cfg.super_resolution_power = int(np.clip(web_merge_config.get("superResolution", 0), 0, 100))
                cfg.image_denoise_power = int(np.clip(web_merge_config.get("imageDenoise", 0), 0, 500))
                cfg.bicubic_degrade_power = int(np.clip(web_merge_config.get("bicubicDegrade", 0), 0, 100))
                cfg.color_degrade_power = int(np.clip(web_merge_config.get("colorDegrade", 0), 0, 100))
            cfg.sharpen_mode = int(np.clip(web_merge_config.get("sharpenMode", 0), 0, 2))
            cfg.blursharpen_amount = int(np.clip(web_merge_config.get("sharpenAmount", 0), -100, 100))
            subprocess_count = int(np.clip(
                web_merge_config.get("workers", max(8, multiprocessing.cpu_count())),
                1,
                multiprocessing.cpu_count(),
            ))
            io.log_info("已应用 Web 合成参数；不会打开 Merger 窗口。")
        else:
            is_interactive = io.input_bool ("使用交互式合成器?", True) if not io.is_colab() else False # 是否使用交互式合并器

            if not is_interactive:  # 如果不是交互式的
                cfg.ask_settings()  # 请求配置设置

            subprocess_count = io.input_int("工作线程数?", max(8, multiprocessing.cpu_count()),
                                            valid_range=[1, multiprocessing.cpu_count()], help_message="指定要处理的线程数。低值可能影响性能。高值可能导致内存错误。该值不能大于CPU核心数" )

        input_path_image_paths = pathex.get_image_paths(input_path)  # 获取输入路径下的图片路径


        if cfg.type == MergerConfig.TYPE_MASKED:  # 如果配置类型为遮罩合并
            if not aligned_path.exists():  # 检查Aligned目录是否存在
                io.log_err('Aligned 目录未找到，请确保它存在。')  # Aligned目录不存在的错误消息
                return

            packed_samples = None
            try:
                packed_samples = samplelib.PackedFaceset.load(aligned_path)  # 尝试加载打包的面部集
            except:
                io.log_err(f"加载 samplelib.PackedFaceset.load {str(aligned_path)}时发生错误, {traceback.format_exc()}")


            if packed_samples is not None:  # 如果成功加载了打包的面部集
                io.log_info ("使用打包的面部集。")  # 使用打包的面部集的日志信息
                def generator():  # 定义生成器函数
                    for sample in io.progress_bar_generator( packed_samples, "收集Aligned信息"):  # 进度条生成器
                        filepath = Path(sample.filename)  # 文件路径
                        yield filepath, DFLIMG.load(filepath, loader_func=lambda x: sample.read_raw_file()  )  # 加载DFLIMG
            else:
                def generator():  # 定义备用生成器函数
                    for filepath in io.progress_bar_generator( pathex.get_image_paths(aligned_path), "收集Aligned信息"):  # 进度条生成器
                        filepath = Path(filepath)  # 文件路径
                        yield filepath, DFLIMG.load(filepath)  # 加载DFLIMG

            alignments = {}  # 初始化Aligned字典
            multiple_faces_detected = False  # 多面孔检测标志

            for filepath, dflimg in generator():  # 遍历生成器
                if dflimg is None or not dflimg.has_data():  # 如果DFLIMG无效或无数据
                    io.log_err (f"{filepath.name} 不是一个dfl图像文件")  # 非DFL图像文件的错误消息
                    continue

                source_filename = dflimg.get_source_filename()  # 获取源文件名
                if source_filename is None:  # 如果源文件名不存在
                    continue

                source_filepath = Path(source_filename)  # 源文件路径
                source_filename_stem = source_filepath.stem  # 源文件基本名

                if source_filename_stem not in alignments.keys():  # 如果基本名不在Aligned字典中
                    alignments[ source_filename_stem ] = []  # 初始化键值

                alignments_ar = alignments[ source_filename_stem ]  # 获取Aligned数组
                alignments_ar.append ( (dflimg.get_source_landmarks(), filepath, source_filepath ) )  # 添加Aligned信息

                if len(alignments_ar) > 1:  # 如果Aligned数组长度大于1
                    multiple_faces_detected = True  # 设置多面孔检测标志为真

            if multiple_faces_detected:  # 如果检测到多面孔
                io.log_info ("")  # 输出空日志信息
                io.log_info ("警告：检测到多张面孔。每个源文件应只对应一个Aligned文件。")  # 输出警告信息
                io.log_info ("")  # 输出空日志信息

            for a_key in list(alignments.keys()):  # 遍历Aligned字典键值
                a_ar = alignments[a_key]  # 获取Aligned数组
                if len(a_ar) > 1:  # 如果Aligned数组长度大于1
                    for _, filepath, source_filepath in a_ar:  # 遍历Aligned数组
                        io.log_info (f"Aligned {filepath.name} 指向 {source_filepath.name} ")  # 输出Aligned信息
                    io.log_info ("")  # 输出空日志信息

                alignments[a_key] = [ a[0] for a in a_ar]  # 从Aligned数组中提取Aligned信息并更新字典

            if multiple_faces_detected:  # 如果检测到多面孔
                io.log_info ("强烈建议单独处理每张面孔。")  # 输出处理建议
                io.log_info ("使用'恢复原始文件名'来确定确切的重复项。")  # 输出使用建议
                io.log_info ("")  # 输出空日志信息

            frames = [ InteractiveMergerSubprocessor.Frame( frame_info=FrameInfo(filepath=Path(p),
                                                                     landmarks_list=alignments.get(Path(p).stem, None)
                                                                    )
                                              )
                       for p in input_path_image_paths ]  # 创建帧列表

            if multiple_faces_detected:  # 如果检测到多面孔
                io.log_info ("警告：检测到多张面孔。不会使用运动模糊。")  # 输出警告信息
                io.log_info ("")  # 输出空日志信息
            else:
                s = 256  # 设置尺寸
                local_pts = [ (s//2-1, s//2-1), (s//2-1,0) ] # 中心和上方点
                frames_len = len(frames)  # 帧长度
                for i in io.progress_bar_generator( range(len(frames)) , "计算运动矢量"):  # 进度条生成器
                    fi_prev = frames[max(0, i-1)].frame_info  # 获取前一帧信息
                    fi      = frames[i].frame_info  # 获取当前帧信息
                    fi_next = frames[min(i+1, frames_len-1)].frame_info  # 获取下一帧信息
                    if len(fi_prev.landmarks_list) == 0 or \
                       len(fi.landmarks_list) == 0 or \
                       len(fi_next.landmarks_list) == 0:  # 如果任一帧无Aligned信息
                            continue

                    mat_prev = LandmarksProcessor.get_transform_mat ( fi_prev.landmarks_list[0], s, face_type=FaceType.FULL)  # 获取前一帧变换矩阵
                    mat      = LandmarksProcessor.get_transform_mat ( fi.landmarks_list[0]     , s, face_type=FaceType.FULL)  # 获取当前帧变换矩阵
                    mat_next = LandmarksProcessor.get_transform_mat ( fi_next.landmarks_list[0], s, face_type=FaceType.FULL)  # 获取下一帧变换矩阵

                    pts_prev = LandmarksProcessor.transform_points (local_pts, mat_prev, True)  # 转换前一帧点
                    pts      = LandmarksProcessor.transform_points (local_pts, mat, True)  # 转换当前帧点
                    pts_next = LandmarksProcessor.transform_points (local_pts, mat_next, True)  # 转换下一帧点

                    prev_vector = pts[0]-pts_prev[0]  # 前向矢量
                    next_vector = pts_next[0]-pts[0]  # 后向矢量

                    motion_vector = pts_next[0] - pts_prev[0]  # 运动矢量
                    fi.motion_power = npla.norm(motion_vector)  # 运动强度

                    motion_vector = motion_vector / fi.motion_power if fi.motion_power != 0 else np.array([0,0],dtype=np.float32)  # 规范化运动矢量

                    fi.motion_deg = -math.atan2(motion_vector[1],motion_vector[0])*180 / math.pi  # 运动角度


        if len(frames) == 0:  # 如果无帧可合并
            io.log_info ("输入目录中没有帧可合并。")  # 输出信息
        else:
            if False:  # 保留用于可能的条件扩展
                pass
            else:
                InteractiveMergerSubprocessor (  # 创建交互式合并子处理器实例并运行
                            is_interactive         = is_interactive,  # 是否交互式
                            merger_session_filepath = model.get_strpath_storage_for_file('merger_session.dat'),  # 合并会话文件路径
                            predictor_func         = predictor_func,  # 预测函数
                            predictor_input_shape  = predictor_input_shape,  # 预测输入形状
                            face_enhancer_func     = face_enhancer_func,  # 面部增强函数
                            xseg_256_extract_func  = xseg_256_extract_func,  # XSeg提取函数
                            merger_config          = cfg,  # 合并配置
                            frames                 = frames,  # 帧列表
                            frames_root_path       = input_path,  # 帧根路径
                            output_path            = output_path,  # 输出路径
                            output_mask_path       = output_mask_path,  # 输出遮罩路径
                            model_iter             = model.get_iter(),  # 模型迭代
                            subprocess_count       = subprocess_count,  # 子进程数量
                        ).run()

        model.finalize()  # 最终化模型

    except Exception as e:  # 捕获异常
        print ( traceback.format_exc() )  # 打印异常堆栈



"""
elif cfg.type == MergerConfig.TYPE_FACE_AVATAR:
filesdata = []
for filepath in io.progress_bar_generator(input_path_image_paths, "Collecting info"):
    filepath = Path(filepath)

    dflimg = DFLIMG.x(filepath)
    if dflimg is None:
        io.log_err ("%s 不是DFL图像文件" % (filepath.name) )
        continue
    filesdata += [ ( FrameInfo(filepath=filepath, landmarks_list=[dflimg.get_landmarks()] ), dflimg.get_source_filename() ) ]

filesdata = sorted(filesdata, key=operator.itemgetter(1)) #sort by source_filename
frames = []
filesdata_len = len(filesdata)
for i in range(len(filesdata)):
    frame_info = filesdata[i][0]

    prev_temporal_frame_infos = []
    next_temporal_frame_infos = []

    for t in range (cfg.temporal_face_count):
        prev_frame_info = filesdata[ max(i -t, 0) ][0]
        next_frame_info = filesdata[ min(i +t, filesdata_len-1 )][0]

        prev_temporal_frame_infos.insert (0, prev_frame_info )
        next_temporal_frame_infos.append (   next_frame_info )

    frames.append ( InteractiveMergerSubprocessor.Frame(prev_temporal_frame_infos=prev_temporal_frame_infos,
                                                frame_info=frame_info,
                                                next_temporal_frame_infos=next_temporal_frame_infos) )
"""

#interpolate landmarks
#from facelib import LandmarksProcessor
#from facelib import FaceType
#a = sorted(alignments.keys())
#a_len = len(a)
#
#box_pts = 3
#box = np.ones(box_pts)/box_pts
#for i in range( a_len ):
#    if i >= box_pts and i <= a_len-box_pts-1:
#        af0 = alignments[ a[i] ][0] ##first face
#        m0 = LandmarksProcessor.get_transform_mat (af0, 256, face_type=FaceType.FULL)
#
#        points = []
#
#        for j in range(-box_pts, box_pts+1):
#            af = alignments[ a[i+j] ][0] ##first face
#            m = LandmarksProcessor.get_transform_mat (af, 256, face_type=FaceType.FULL)
#            p = LandmarksProcessor.transform_points (af, m)
#            points.append (p)
#
#        points = np.array(points)
#        points_len = len(points)
#        t_points = np.transpose(points, [1,0,2])
#
#        p1 = np.array ( [ int(np.convolve(x[:,0], box, mode='same')[points_len//2]) for x in t_points ] )
#        p2 = np.array ( [ int(np.convolve(x[:,1], box, mode='same')[points_len//2]) for x in t_points ] )
#
#        new_points = np.concatenate( [np.expand_dims(p1,-1),np.expand_dims(p2,-1)], -1 )
#
#        alignments[ a[i] ][0]  = LandmarksProcessor.transform_points (new_points, m0, True).astype(np.int32)
