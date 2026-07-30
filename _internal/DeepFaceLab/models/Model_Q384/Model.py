import multiprocessing
import operator

import numpy as np

import os
import shutil

# from psutil import cpu_count

from core.interact import interact as io
from core.leras import nn
from facelib import FaceType
from models import ModelBase
from samplelib import *

from pathlib import Path

from utils.label_face import label_face_filename

from utils.train_status_export import data_format_change, prepare_sample
import cv2
from core.cv2ex import cv2_imwrite
from tqdm import tqdm


class MEModel(ModelBase):
    # 重写父类的on_initialize_options方法
    def on_initialize_options(self):
        # 获取当前的设备配置
        device_config = nn.getCurrentDeviceConfig()

        # 根据设备的VRAM容量建议批处理大小
        lowest_vram = 4
        if len(device_config.devices) != 0:
            lowest_vram = device_config.devices.get_worst_device().total_mem_gb
        if lowest_vram >= 11:
            suggest_batch_size = 8
        else:
            suggest_batch_size = 4

        self.batch_size = suggest_batch_size
        
        default_archi = self.options["archi"] = self.load_or_def_option(
            "archi", "df-ud"
        )
        default_models_opt_on_gpu = self.options["models_opt_on_gpu"] = (
            self.load_or_def_option("models_opt_on_gpu", True)
        )

        default_uniform_yaw = self.options["uniform_yaw"] = self.load_or_def_option(
            "uniform_yaw", False
        )

        default_adabelief = self.options["adabelief"] = True

        lr_dropout = self.load_or_def_option("lr_dropout", "n")
        lr_dropout = {True: "y", False: "n"}.get(
            lr_dropout, lr_dropout
        )  # backward comp
        default_lr_dropout = self.options["lr_dropout"] = lr_dropout

        default_loss_function = self.options["loss_function"] = "SSIM"
        
        default_random_warp = self.options["random_warp"] = self.load_or_def_option(
            "random_warp", True
        )
        default_random_hsv_power = self.options["random_hsv_power"] = 0
        default_random_downsample = self.options["random_downsample"] = False
        default_random_noise = self.options["random_noise"] = False
        default_random_blur = self.options["random_blur"] = False
        default_random_jpeg = self.options["random_jpeg"] = False
        default_super_warp = self.options["super_warp"] = False
        
        default_rotation_range = self.rotation_range = [-3, 3]
        default_scale_range = self.scale_range = [-0.15, 0.15]

        # 加载或定义其他训练相关的默认选项

        default_true_face_power = self.options["true_face_power"] = 0.0

        default_ct_mode = self.options["ct_mode"] = self.load_or_def_option(
            "ct_mode", "none"
        )
        default_random_color = self.options["random_color"] = False
        
        default_clipgrad = self.options["clipgrad"] = True
        
        default_pretrain = self.options["pretrain"] = False

        default_cpu_cap = self.options["cpu_cap"] = suggest_batch_size
        
        default_preview_samples = self.options["preview_samples"] = 2

        default_full_preview = self.options["force_full_preview"] = False

        default_lr = self.options["lr"] = self.load_or_def_option("lr", 1e-4)

        default_quick_opt = self.options["quick_opt"] = self.load_or_def_option("quick_opt", True)
        
        # 判断是否需要覆盖模型设置
        ask_override = self.ask_override()
        self.quick_opt=default_quick_opt
        if ask_override:
            # 如果是首次运行或需要覆盖设置，则询问用户输入各种配置
            self.ask_random_src_flip()
            self.ask_quick_opt()
        if self.is_first_run():
            self.random_src_flip = True
            self.quick_opt = True
            
    # 重写父类的on_initialize方法
    def on_initialize(self):
        # 获取当前设备配置和初始化数据格式
        device_config = nn.getCurrentDeviceConfig()
        devices = device_config.devices
        self.model_data_format = (
            "NCHW" if len(devices) != 0 and not self.is_debug() else "NHWC"
        )
        nn.initialize(data_format=self.model_data_format)
        tf = nn.tf  # TensorFlow引用

        # 设置分辨率和脸部类型
        resolution = self.resolution = 384  # 设置分辨率为224
        self.face_type = FaceType.WHOLE_FACE  # 设置脸部类型为整脸
        ae_dims = 32  # 设置ae维度为192
        e_dims = 96  # 设置e维度为64
        d_dims = 96  # 设置d维度为64
        d_mask_dims = 32  # 设置d_mask维度为16
        if self.quick_opt:
            io.log_info("当前训练眼嘴")
        else:
            io.log_info("当前训练皮肤")
        # 设置眼睛和嘴巴优先级
        eyes_prio = True if self.quick_opt else False
        mouth_prio = True if self.quick_opt else False

        # 解析架构类型
        archi_split = self.options["archi"].split("-")
        if len(archi_split) == 2:
            archi_type, archi_opts = archi_split
        elif len(archi_split) == 1:
            archi_type, archi_opts = archi_split[0], None
        self.archi_type = archi_type        
        model_archi = nn.DeepFakeArchi(resolution, use_fp16=False, opts=archi_opts)  # 创建模型架构

        # 设置是否预训练
        self.pretrain = False  # 是否预训练为False
        self.pretrain_just_disabled = False  # 是否刚刚禁用预训练为False
        masked_training = True

        # 设置是否使用AdaBelief优化器
        adabelief = self.options["adabelief"]

        # 设置是否使用半精度浮点数
        if self.is_exporting:
            use_fp16 = io.input_bool(
                "使用量化导出?",
                True,
                help_message="建议开启量化，更轻更快。",
            )

        # 设置相关参数 （已解锁预训练的所有锁定，除了GAN）
        self.gan_power = gan_power = 0.0

        if self.is_first_run():
            random_warp = False
        else:
            random_warp = True if self.quick_opt else False

        random_src_flip = self.random_src_flip
        random_dst_flip = True
        random_hsv_power = 0.0
        blur_out_mask = False
        
        ct_mode = None if self.quick_opt else "fs-aug"

        # 设置模型优化选项
        models_opt_on_gpu = (
            False if len(devices) == 0 else self.options["models_opt_on_gpu"]
        )
        models_opt_device = (
            nn.tf_default_device_name
            if models_opt_on_gpu and self.is_training
            else "/CPU:0"
        )
        optimizer_vars_on_cpu = models_opt_device == "/CPU:0"

        # 设置输入通道和形状
        input_ch = 3
        bgr_shape = self.bgr_shape = nn.get4Dshape(resolution, resolution, input_ch)
        mask_shape = nn.get4Dshape(resolution, resolution, 1)
        self.model_filename_list = []

        with tf.device("/CPU:0"):
            # 在CPU上初始化占位符
            self.warped_src = tf.placeholder(nn.floatx, bgr_shape, name="warped_src")
            self.warped_dst = tf.placeholder(nn.floatx, bgr_shape, name="warped_dst")

            self.target_src = tf.placeholder(nn.floatx, bgr_shape, name="target_src")
            self.target_dst = tf.placeholder(nn.floatx, bgr_shape, name="target_dst")

            self.target_srcm = tf.placeholder(nn.floatx, mask_shape, name="target_srcm")
            self.target_srcm_em = tf.placeholder(
                nn.floatx, mask_shape, name="target_srcm_em"
            )
            self.target_dstm = tf.placeholder(nn.floatx, mask_shape, name="target_dstm")
            self.target_dstm_em = tf.placeholder(
                nn.floatx, mask_shape, name="target_dstm_em"
            )

        # 初始化模型架构
        model_archi = nn.DeepFakeArchi(resolution, use_fp16=False, opts="ud")

        # 继续初始化模型的其他组件
        with tf.device(models_opt_device):
            # 根据架构类型初始化模型的不同部分
            if "df" in archi_type:
                # DF架构
                self.encoder = model_archi.Encoder(
                    in_ch=input_ch, e_ch=e_dims, name="encoder"
                )
                encoder_out_ch = (
                    self.encoder.get_out_ch()
                    * self.encoder.get_out_res(resolution) ** 2
                )

                self.inter = model_archi.Inter(
                    in_ch=encoder_out_ch, ae_ch=ae_dims, ae_out_ch=ae_dims, name="inter"
                )
                inter_out_ch = self.inter.get_out_ch()

                self.decoder_src = model_archi.Decoder(
                    in_ch=inter_out_ch,
                    d_ch=d_dims,
                    d_mask_ch=d_mask_dims,
                    name="decoder_src",
                )
                self.decoder_dst = model_archi.Decoder(
                    in_ch=inter_out_ch,
                    d_ch=d_dims,
                    d_mask_ch=d_mask_dims,
                    name="decoder_dst",
                )

                self.model_filename_list += [
                    [self.encoder, "encoder.npy"],
                    [self.inter, "inter.npy"],
                    [self.decoder_src, "decoder_src.npy"],
                    [self.decoder_dst, "decoder_dst.npy"],
                ]

                # 如果正在训练，初始化代码鉴别器
                if self.is_training:
                    if self.options["true_face_power"] != 0:
                        self.code_discriminator = nn.CodeDiscriminator(
                            ae_dims, code_res=self.inter.get_out_res(), name="dis"
                        )
                        self.model_filename_list += [
                            [self.code_discriminator, "code_discriminator.npy"]
                        ]

            elif "liae" in archi_type:
                # LIAE架构
                self.encoder = model_archi.Encoder(
                    in_ch=input_ch, e_ch=e_dims, name="encoder"
                )
                encoder_out_ch = (
                    self.encoder.get_out_ch()
                    * self.encoder.get_out_res(resolution) ** 2
                )

                self.inter_AB = model_archi.Inter(
                    in_ch=encoder_out_ch,
                    ae_ch=ae_dims,
                    ae_out_ch=ae_dims * 2,
                    name="inter_AB",
                )
                self.inter_B = model_archi.Inter(
                    in_ch=encoder_out_ch,
                    ae_ch=ae_dims,
                    ae_out_ch=ae_dims * 2,
                    name="inter_B",
                )

                inter_out_ch = self.inter_AB.get_out_ch()
                inters_out_ch = inter_out_ch * 2
                self.decoder = model_archi.Decoder(
                    in_ch=inters_out_ch,
                    d_ch=d_dims,
                    d_mask_ch=d_mask_dims,
                    name="decoder",
                )

                self.model_filename_list += [
                    [self.encoder, "encoder.npy"],
                    [self.inter_AB, "inter_AB.npy"],
                    [self.inter_B, "inter_B.npy"],
                    [self.decoder, "decoder.npy"],
                ]

            if self.is_training:
                if gan_power != 0:
                    self.D_src = nn.UNetPatchDiscriminator(
                        patch_size=64,
                        in_ch=input_ch,
                        base_ch=16,
                        use_fp16=False,
                        name="D_src",
                    )
                    self.model_filename_list += [[self.D_src, "GAN.npy"]]

                # 初始化优化器
                lr = self.options["lr"]

                if self.options["lr_dropout"] in ["y", "cpu"] and not self.pretrain:
                    lr_cos = 500
                    lr_dropout = 0.3
                else:
                    lr_cos = 0
                    lr_dropout = 1.0
                OptimizerClass = nn.AdaBelief
                clipnorm = 1.0

                # 根据架构类型设置优化器
                if "df" in archi_type:
                    self.src_dst_saveable_weights = (
                        self.encoder.get_weights()
                        + self.inter.get_weights()
                        + self.decoder_src.get_weights()
                        + self.decoder_dst.get_weights()
                    )
                    self.src_dst_trainable_weights = self.src_dst_saveable_weights
                elif "liae" in archi_type:
                    self.src_dst_saveable_weights = (
                        self.encoder.get_weights()
                        + self.inter_AB.get_weights()
                        + self.inter_B.get_weights()
                        + self.decoder.get_weights()
                    )
                    if random_warp:
                        self.src_dst_trainable_weights = self.src_dst_saveable_weights
                    else:
                        self.src_dst_trainable_weights = (
                            self.encoder.get_weights()
                            + self.inter_B.get_weights()
                            + self.decoder.get_weights()
                        )

                # 初始化源和目标的优化器
                self.src_dst_opt = OptimizerClass(
                    lr=lr,
                    lr_dropout=lr_dropout,
                    lr_cos=lr_cos,
                    clipnorm=clipnorm,
                    name="src_dst_opt",
                )
                self.src_dst_opt.initialize_variables(
                    self.src_dst_saveable_weights,
                    vars_on_cpu=optimizer_vars_on_cpu,
                    lr_dropout_on_cpu=self.options["lr_dropout"] == "cpu",
                )
                self.model_filename_list += [(self.src_dst_opt, "src_dst_opt.npy")]

                # 如果使用GAN，初始化GAN鉴别器优化器
                if gan_power != 0:
                    self.D_src_dst_opt = OptimizerClass(
                        lr=lr,
                        lr_dropout=lr_dropout,
                        lr_cos=lr_cos,
                        clipnorm=clipnorm,
                        name="GAN_opt",
                    )
                    self.D_src_dst_opt.initialize_variables(
                        self.D_src.get_weights(),
                        vars_on_cpu=optimizer_vars_on_cpu,
                        lr_dropout_on_cpu=self.options["lr_dropout"] == "cpu",
                    )  # +self.D_src_x2.get_weights()
                    self.model_filename_list += [(self.D_src_dst_opt, "GAN_opt.npy")]

        if self.is_training:
            # 调整多GPU环境下的批处理大小
            gpu_count = max(1, len(devices))  # 获取GPU数量，至少为1
            bs_per_gpu = max(
                1, self.get_batch_size() // gpu_count
            )  # 每个GPU的批处理大小，至少为1
            self.set_batch_size(gpu_count * bs_per_gpu)  # 设置总的批处理大小

            # 计算每个GPU的损失
            gpu_pred_src_src_list = []  # GPU预测源到源的列表
            gpu_pred_dst_dst_list = []  # GPU预测目标到目标的列表
            gpu_pred_src_dst_list = []  # GPU预测源到目标的列表
            gpu_pred_src_srcm_list = []  # GPU预测源到源掩码的列表
            gpu_pred_dst_dstm_list = []  # GPU预测目标到目标掩码的列表
            gpu_pred_src_dstm_list = []  # GPU预测源到目标掩码的列表

            gpu_src_losses = []  # GPU源损失列表
            gpu_dst_losses = []  # GPU目标损失列表
            gpu_G_loss_gvs = []  # GPU生成器损失梯度列表
            gpu_D_code_loss_gvs = []  # GPU判别器编码损失梯度列表
            gpu_D_src_dst_loss_gvs = []  # GPU判别器源到目标损失梯度列表

            for gpu_id in range(gpu_count):
                with tf.device(
                    f"/{devices[gpu_id].tf_dev_type}:{gpu_id}"
                    if len(devices) != 0
                    else f"/CPU:0"
                ):
                    with tf.device(f"/CPU:0"):
                        # 在CPU上进行切片操作，以避免所有批处理数据首先被传输到GPU
                        batch_slice = slice(
                            gpu_id * bs_per_gpu, (gpu_id + 1) * bs_per_gpu
                        )
                        gpu_warped_src = self.warped_src[
                            batch_slice, :, :, :
                        ]  # 切片后的变形源图像
                        gpu_warped_dst = self.warped_dst[
                            batch_slice, :, :, :
                        ]  # 切片后的变形目标图像
                        gpu_target_src = self.target_src[
                            batch_slice, :, :, :
                        ]  # 切片后的目标源图像
                        gpu_target_dst = self.target_dst[
                            batch_slice, :, :, :
                        ]  # 切片后的目标目标图像
                        gpu_target_srcm_all = self.target_srcm[
                            batch_slice, :, :, :
                        ]  # 切片后的目标源掩码
                        gpu_target_srcm_em = self.target_srcm_em[
                            batch_slice, :, :, :
                        ]  # 切片后的目标源紧急掩码
                        gpu_target_dstm_all = self.target_dstm[
                            batch_slice, :, :, :
                        ]  # 切片后的目标目标掩码
                        gpu_target_dstm_em = self.target_dstm_em[
                            batch_slice, :, :, :
                        ]  # 切片后的目标目标紧急掩码

                    gpu_target_srcm_anti = 1 - gpu_target_srcm_all  # 源反向掩码
                    gpu_target_dstm_anti = 1 - gpu_target_dstm_all  # 目标反向掩码


                    # 处理模型张量
                    if "df" in archi_type:
                        # 使用'df'架构类型
                        gpu_src_code = self.inter(self.encoder(gpu_warped_src))
                        gpu_dst_code = self.inter(self.encoder(gpu_warped_dst))
                        gpu_pred_src_src, gpu_pred_src_srcm = self.decoder_src(
                            gpu_src_code
                        )
                        gpu_pred_dst_dst, gpu_pred_dst_dstm = self.decoder_dst(
                            gpu_dst_code
                        )
                        gpu_pred_src_dst, gpu_pred_src_dstm = self.decoder_src(
                            gpu_dst_code
                        )
                        gpu_pred_src_dst_no_code_grad, _ = self.decoder_src(
                            tf.stop_gradient(gpu_dst_code)
                        )

                    elif "liae" in archi_type:
                        # 使用'liae'架构类型
                        gpu_src_code = self.encoder(gpu_warped_src)
                        gpu_src_inter_AB_code = self.inter_AB(gpu_src_code)
                        gpu_src_code = tf.concat(
                            [gpu_src_inter_AB_code, gpu_src_inter_AB_code],
                            nn.conv2d_ch_axis,
                        )
                        gpu_dst_code = self.encoder(gpu_warped_dst)
                        gpu_dst_inter_B_code = self.inter_B(gpu_dst_code)
                        gpu_dst_inter_AB_code = self.inter_AB(gpu_dst_code)
                        gpu_dst_code = tf.concat(
                            [gpu_dst_inter_B_code, gpu_dst_inter_AB_code],
                            nn.conv2d_ch_axis,
                        )
                        gpu_src_dst_code = tf.concat(
                            [gpu_dst_inter_AB_code, gpu_dst_inter_AB_code],
                            nn.conv2d_ch_axis,
                        )

                        gpu_pred_src_src, gpu_pred_src_srcm = self.decoder(gpu_src_code)
                        gpu_pred_dst_dst, gpu_pred_dst_dstm = self.decoder(gpu_dst_code)
                        gpu_pred_src_dst, gpu_pred_src_dstm = self.decoder(
                            gpu_src_dst_code
                        )
                        gpu_pred_src_dst_no_code_grad, _ = self.decoder(
                            tf.stop_gradient(gpu_src_dst_code)
                        )

                    gpu_pred_src_src_list.append(
                        gpu_pred_src_src
                    )  # 将GPU预测的源到源结果添加到列表
                    gpu_pred_dst_dst_list.append(
                        gpu_pred_dst_dst
                    )  # 将GPU预测的目标到目标结果添加到列表
                    gpu_pred_src_dst_list.append(
                        gpu_pred_src_dst
                    )  # 将GPU预测的源到目标结果添加到列表

                    gpu_pred_src_srcm_list.append(
                        gpu_pred_src_srcm
                    )  # 将GPU预测的源到源掩码添加到列表
                    gpu_pred_dst_dstm_list.append(
                        gpu_pred_dst_dstm
                    )  # 将GPU预测的目标到目标掩码添加到列表
                    gpu_pred_src_dstm_list.append(
                        gpu_pred_src_dstm
                    )  # 将GPU预测的源到目标掩码添加到列表

                    # 从一个组合掩码中解包各个掩码
                    gpu_target_srcm = tf.clip_by_value(
                        gpu_target_srcm_all, 0, 1
                    )  # GPU源掩码
                    gpu_target_dstm = tf.clip_by_value(
                        gpu_target_dstm_all, 0, 1
                    )  # GPU目标掩码
                    gpu_target_srcm_eye_mouth = tf.clip_by_value(
                        gpu_target_srcm_em - 1, 0, 1
                    )  # GPU源眼睛嘴巴掩码
                    gpu_target_dstm_eye_mouth = tf.clip_by_value(
                        gpu_target_dstm_em - 1, 0, 1
                    )  # GPU目标眼睛嘴巴掩码
                    gpu_target_srcm_mouth = tf.clip_by_value(
                        gpu_target_srcm_em - 2, 0, 1
                    )  # GPU源嘴巴掩码
                    gpu_target_dstm_mouth = tf.clip_by_value(
                        gpu_target_dstm_em - 2, 0, 1
                    )  # GPU目标嘴巴掩码
                    gpu_target_srcm_eyes = tf.clip_by_value(
                        gpu_target_srcm_eye_mouth - gpu_target_srcm_mouth, 0, 1
                    )  # GPU源眼睛掩码
                    gpu_target_dstm_eyes = tf.clip_by_value(
                        gpu_target_dstm_eye_mouth - gpu_target_dstm_mouth, 0, 1
                    )  # GPU目标眼睛掩码

                    gpu_target_srcm_blur = nn.gaussian_blur(
                        gpu_target_srcm, max(1, resolution // 32)
                    )  # 模糊处理GPU源掩码
                    gpu_target_srcm_blur = (
                        tf.clip_by_value(gpu_target_srcm_blur, 0, 0.5) * 2
                    )
                    gpu_target_srcm_anti_blur = (
                        1.0 - gpu_target_srcm_blur
                    )  # 反向模糊处理GPU源掩码

                    gpu_target_dstm_blur = nn.gaussian_blur(
                        gpu_target_dstm, max(1, resolution // 32)
                    )  # 模糊处理GPU目标掩码
                    gpu_target_dstm_blur = (
                        tf.clip_by_value(gpu_target_dstm_blur, 0, 0.5) * 2
                    )

                    gpu_style_mask_blur = nn.gaussian_blur(
                        gpu_pred_src_dstm * gpu_pred_dst_dstm, max(1, resolution // 32)
                    )  # 模糊处理风格掩码
                    gpu_style_mask_blur = tf.stop_gradient(
                        tf.clip_by_value(gpu_target_srcm_blur, 0, 1.0)
                    )
                    gpu_style_mask_anti_blur = (
                        1.0 - gpu_style_mask_blur
                    )  # 反向模糊处理风格掩码

                    gpu_target_dst_masked = (
                        gpu_target_dst * gpu_target_dstm_blur
                    )  # 应用模糊处理的GPU目标掩码

                    gpu_target_src_anti_masked = (
                        gpu_target_src * gpu_target_srcm_anti_blur
                    )  # 应用反向模糊处理的GPU源图像
                    gpu_pred_src_src_anti_masked = (
                        gpu_pred_src_src * gpu_target_srcm_anti_blur
                    )  # 应用反向模糊处理的GPU源预测图像

                    gpu_target_src_masked_opt = (
                        gpu_target_src * gpu_target_srcm_blur
                        if masked_training
                        else gpu_target_src
                    )  # 根据是否掩码训练选择GPU源图像
                    gpu_target_dst_masked_opt = (
                        gpu_target_dst_masked if masked_training else gpu_target_dst
                    )  # 根据是否掩码训练选择GPU目标图像
                    gpu_pred_src_src_masked_opt = (
                        gpu_pred_src_src * gpu_target_srcm_blur
                        if masked_training
                        else gpu_pred_src_src
                    )  # 根据是否掩码训练选择GPU源预测图像
                    gpu_pred_dst_dst_masked_opt = (
                        gpu_pred_dst_dst * gpu_target_dstm_blur
                        if masked_training
                        else gpu_pred_dst_dst
                    )  # 根据是否掩码训练选择GPU目标预测图像



                    gpu_src_loss = tf.reduce_mean(
                        5
                        * nn.dssim(
                            gpu_target_src_masked_opt,
                            gpu_pred_src_src_masked_opt,
                            max_val=1.0,
                            filter_size=int(resolution / 11.6),
                        ),
                        axis=[1],
                    )
                    gpu_src_loss += tf.reduce_mean(
                        5
                        * nn.dssim(
                            gpu_target_src_masked_opt,
                            gpu_pred_src_src_masked_opt,
                            max_val=1.0,
                            filter_size=int(resolution / 23.2),
                        ),
                        axis=[1],
                    )
                    gpu_src_loss += tf.reduce_mean(
                        10
                        * tf.square(
                            gpu_target_src_masked_opt - gpu_pred_src_src_masked_opt
                        ),
                        axis=[1, 2, 3],
                    )

                    if eyes_prio or mouth_prio:
                        # 如果设置了眼睛或嘴巴优先级
                        if eyes_prio and mouth_prio:
                            gpu_target_part_mask = gpu_target_srcm_eye_mouth
                        elif eyes_prio:
                            gpu_target_part_mask = gpu_target_srcm_eyes
                        elif mouth_prio:
                            gpu_target_part_mask = gpu_target_srcm_mouth

                        gpu_src_loss += tf.reduce_mean(
                            300
                            * tf.abs(
                                gpu_target_src * gpu_target_part_mask
                                - gpu_pred_src_src * gpu_target_part_mask
                            ),
                            axis=[1, 2, 3],
                        )

                    gpu_src_loss += tf.reduce_mean(
                        10 * tf.square(gpu_target_srcm - gpu_pred_src_srcm),
                        axis=[1, 2, 3],
                    )  # 计算GPU源掩码和GPU源预测掩码之间的损失
                    

                    gpu_dst_loss = tf.reduce_mean(
                        5
                        * nn.dssim(
                            gpu_target_dst_masked_opt,
                            gpu_pred_dst_dst_masked_opt,
                            max_val=1.0,
                            filter_size=int(resolution / 11.6),
                        ),
                        axis=[1],
                    )
                    gpu_dst_loss += tf.reduce_mean(
                        5
                        * nn.dssim(
                            gpu_target_dst_masked_opt,
                            gpu_pred_dst_dst_masked_opt,
                            max_val=1.0,
                            filter_size=int(resolution / 23.2),
                        ),
                        axis=[1],
                    )
                    gpu_dst_loss += tf.reduce_mean(
                        10
                        * tf.square(
                            gpu_target_dst_masked_opt - gpu_pred_dst_dst_masked_opt
                        ),
                        axis=[1, 2, 3],
                    )

                    if eyes_prio or mouth_prio:
                        if eyes_prio and mouth_prio:
                            gpu_target_part_mask = gpu_target_dstm_eye_mouth
                        elif eyes_prio:
                            gpu_target_part_mask = gpu_target_dstm_eyes
                        elif mouth_prio:
                            gpu_target_part_mask = gpu_target_dstm_mouth

                        gpu_dst_loss += tf.reduce_mean(
                            300
                            * tf.abs(
                                gpu_target_dst * gpu_target_part_mask
                                - gpu_pred_dst_dst * gpu_target_part_mask
                            ),
                            axis=[1, 2, 3],
                        )

                    gpu_dst_loss += tf.reduce_mean(
                        10 * tf.square(gpu_target_dstm - gpu_pred_dst_dstm),
                        axis=[1, 2, 3],
                    )

                    gpu_src_losses += [gpu_src_loss]
                    gpu_dst_losses += [gpu_dst_loss]

                    gpu_G_loss = gpu_src_loss + gpu_dst_loss

                    def DLoss(labels, logits):
                        return tf.reduce_mean(
                            tf.nn.sigmoid_cross_entropy_with_logits(
                                labels=labels, logits=logits
                            ),
                            axis=[1, 2, 3],
                        )


                    if gan_power != 0:
                        gpu_pred_src_src_d, gpu_pred_src_src_d2 = self.D_src(
                            gpu_pred_src_src_masked_opt
                        )

                        def get_smooth_noisy_labels(
                            label, tensor, smoothing=0.1, noise=0.05
                        ):
                            num_labels = self.batch_size
                            for d in tensor.get_shape().as_list()[1:]:
                                num_labels *= d

                            probs = (
                                tf.math.log([[noise, 1 - noise]])
                                if label == 1
                                else tf.math.log([[1 - noise, noise]])
                            )
                            x = tf.random.categorical(probs, num_labels)
                            x = tf.cast(x, tf.float32)
                            x = tf.math.scalar_mul(1 - smoothing, x)
                            # x = x + (smoothing/num_labels)
                            x = tf.reshape(
                                x,
                                (self.batch_size,)
                                + tuple(tensor.get_shape().as_list()[1:]),
                            )
                            return x

                        smoothing = 0.1
                        noise = 0.0

                        gpu_pred_src_src_d_ones = tf.ones_like(gpu_pred_src_src_d)
                        gpu_pred_src_src_d2_ones = tf.ones_like(gpu_pred_src_src_d2)

                        gpu_pred_src_src_d_smooth_zeros = get_smooth_noisy_labels(
                            0, gpu_pred_src_src_d, smoothing=smoothing, noise=noise
                        )
                        gpu_pred_src_src_d2_smooth_zeros = get_smooth_noisy_labels(
                            0, gpu_pred_src_src_d2, smoothing=smoothing, noise=noise
                        )

                        gpu_target_src_d, gpu_target_src_d2 = self.D_src(
                            gpu_target_src_masked_opt
                        )

                        gpu_target_src_d_smooth_ones = get_smooth_noisy_labels(
                            1, gpu_target_src_d, smoothing=smoothing, noise=noise
                        )
                        gpu_target_src_d2_smooth_ones = get_smooth_noisy_labels(
                            1, gpu_target_src_d2, smoothing=smoothing, noise=noise
                        )

                        gpu_D_src_dst_loss = (
                            DLoss(gpu_target_src_d_smooth_ones, gpu_target_src_d)
                            + DLoss(gpu_pred_src_src_d_smooth_zeros, gpu_pred_src_src_d)
                            + DLoss(gpu_target_src_d2_smooth_ones, gpu_target_src_d2)
                            + DLoss(
                                gpu_pred_src_src_d2_smooth_zeros, gpu_pred_src_src_d2
                            )
                        )

                        gpu_D_src_dst_loss_gvs += [
                            nn.gradients(gpu_D_src_dst_loss, self.D_src.get_weights())
                        ]  # +self.D_src_x2.get_weights()

                        gpu_G_loss += gan_power * (
                            DLoss(gpu_pred_src_src_d_ones, gpu_pred_src_src_d)
                            + DLoss(gpu_pred_src_src_d2_ones, gpu_pred_src_src_d2)
                        )

                        if masked_training:
                            # Minimal src-src-bg rec with total_variation_mse to suppress random bright dots from gan
                            gpu_G_loss += 0.000001 * nn.total_variation_mse(
                                gpu_pred_src_src
                            )
                            gpu_G_loss += 0.02 * tf.reduce_mean(
                                tf.square(
                                    gpu_pred_src_src_anti_masked
                                    - gpu_target_src_anti_masked
                                ),
                                axis=[1, 2, 3],
                            )

                    gpu_G_loss_gvs += [
                        nn.gradients(gpu_G_loss, self.src_dst_trainable_weights)
                    ]

            # Average losses and gradients, and create optimizer update ops
            with tf.device(f"/CPU:0"):
                pred_src_src = nn.concat(gpu_pred_src_src_list, 0)
                pred_dst_dst = nn.concat(gpu_pred_dst_dst_list, 0)
                pred_src_dst = nn.concat(gpu_pred_src_dst_list, 0)
                pred_src_srcm = nn.concat(gpu_pred_src_srcm_list, 0)
                pred_dst_dstm = nn.concat(gpu_pred_dst_dstm_list, 0)
                pred_src_dstm = nn.concat(gpu_pred_src_dstm_list, 0)

            with tf.device(models_opt_device):
                src_loss = tf.concat(gpu_src_losses, 0)
                dst_loss = tf.concat(gpu_dst_losses, 0)
                src_dst_loss_gv_op = self.src_dst_opt.get_update_op(
                    nn.average_gv_list(gpu_G_loss_gvs)
                )

                if self.options["true_face_power"] != 0:
                    D_loss_gv_op = self.D_code_opt.get_update_op(
                        nn.average_gv_list(gpu_D_code_loss_gvs)
                    )

                if gan_power != 0:
                    src_D_src_dst_loss_gv_op = self.D_src_dst_opt.get_update_op(
                        nn.average_gv_list(gpu_D_src_dst_loss_gvs)
                    )

            # Initializing training and view functions
            def src_dst_train(
                warped_src,
                target_src,
                target_srcm,
                target_srcm_em,
                warped_dst,
                target_dst,
                target_dstm,
                target_dstm_em,
            ):
                s, d = nn.tf_sess.run(
                    [src_loss, dst_loss, src_dst_loss_gv_op],
                    feed_dict={
                        self.warped_src: warped_src,
                        self.target_src: target_src,
                        self.target_srcm: target_srcm,
                        self.target_srcm_em: target_srcm_em,
                        self.warped_dst: warped_dst,
                        self.target_dst: target_dst,
                        self.target_dstm: target_dstm,
                        self.target_dstm_em: target_dstm_em,
                    },
                )[:2]
                return s, d

            self.src_dst_train = src_dst_train

            def get_src_dst_information(
                warped_src,
                target_src,
                target_srcm,
                target_srcm_em,
                warped_dst,
                target_dst,
                target_dstm,
                target_dstm_em,
            ):
                out_data = nn.tf_sess.run(
                    [
                        src_loss,
                        dst_loss,
                        pred_src_src,
                        pred_src_srcm,
                        pred_dst_dst,
                        pred_dst_dstm,
                        pred_src_dst,
                        pred_src_dstm,
                    ],
                    feed_dict={
                        self.warped_src: warped_src,
                        self.target_src: target_src,
                        self.target_srcm: target_srcm,
                        self.target_srcm_em: target_srcm_em,
                        self.warped_dst: warped_dst,
                        self.target_dst: target_dst,
                        self.target_dstm: target_dstm,
                        self.target_dstm_em: target_dstm_em,
                    },
                )

                return out_data

            self.get_src_dst_information = get_src_dst_information

            if self.options["true_face_power"] != 0:

                def D_train(warped_src, warped_dst):
                    nn.tf_sess.run(
                        [D_loss_gv_op],
                        feed_dict={
                            self.warped_src: warped_src,
                            self.warped_dst: warped_dst,
                        },
                    )

                self.D_train = D_train

            if gan_power != 0:

                def D_src_dst_train(
                    warped_src,
                    target_src,
                    target_srcm,
                    target_srcm_em,
                    warped_dst,
                    target_dst,
                    target_dstm,
                    target_dstm_em,
                ):
                    nn.tf_sess.run(
                        [src_D_src_dst_loss_gv_op],
                        feed_dict={
                            self.warped_src: warped_src,
                            self.target_src: target_src,
                            self.target_srcm: target_srcm,
                            self.target_srcm_em: target_srcm_em,
                            self.warped_dst: warped_dst,
                            self.target_dst: target_dst,
                            self.target_dstm: target_dstm,
                            self.target_dstm_em: target_dstm_em,
                        },
                    )

                self.D_src_dst_train = D_src_dst_train

            def AE_view(warped_src, warped_dst):
                return nn.tf_sess.run(
                    [
                        pred_src_src,
                        pred_src_srcm,
                        pred_dst_dst,
                        pred_dst_dstm,
                        pred_src_dst,
                        pred_src_dstm,
                    ],
                    feed_dict={
                        self.warped_src: warped_src,
                        self.warped_dst: warped_dst,
                    },
                )

            self.AE_view = AE_view
        else:
            # Initializing merge function
            with tf.device(
                nn.tf_default_device_name if len(devices) != 0 else f"/CPU:0"
            ):
                if "df" in archi_type:
                    gpu_dst_code = self.inter(self.encoder(self.warped_dst))
                    gpu_pred_src_dst, gpu_pred_src_dstm = self.decoder_src(gpu_dst_code)
                    _, gpu_pred_dst_dstm = self.decoder_dst(gpu_dst_code)

                elif "liae" in archi_type:
                    gpu_dst_code = self.encoder(self.warped_dst)
                    gpu_dst_inter_B_code = self.inter_B(gpu_dst_code)
                    gpu_dst_inter_AB_code = self.inter_AB(gpu_dst_code)
                    gpu_dst_code = tf.concat(
                        [gpu_dst_inter_B_code, gpu_dst_inter_AB_code], nn.conv2d_ch_axis
                    )
                    gpu_src_dst_code = tf.concat(
                        [gpu_dst_inter_AB_code, gpu_dst_inter_AB_code],
                        nn.conv2d_ch_axis,
                    )

                    gpu_pred_src_dst, gpu_pred_src_dstm = self.decoder(gpu_src_dst_code)
                    _, gpu_pred_dst_dstm = self.decoder(gpu_dst_code)

            def AE_merge(warped_dst):
                return nn.tf_sess.run(
                    [gpu_pred_src_dst, gpu_pred_dst_dstm, gpu_pred_src_dstm],
                    feed_dict={self.warped_dst: warped_dst},
                )

            self.AE_merge = AE_merge

        # 遍历模型和对应的文件名
        for model, filename in io.progress_bar_generator(
            self.model_filename_list, "初始化模型"
        ):

            # 尝试从文件加载模型权重
            do_init = not model.load_weights(
                self.get_strpath_storage_for_file(filename)
            )

            if do_init and self.pretrained_model_path is not None:
                pretrained_filepath = self.pretrained_model_path / filename
                # 检查预训练文件路径是否存在
                if pretrained_filepath.exists():
                    #print('找到预置权重')
                    # 尝试加载预训练模型权重，如果失败则设置do_init为True进行初始化
                    do_init = not model.load_weights(pretrained_filepath)
                    
            # 如果需要初始化，初始化模型权重
            if do_init:
                model.init_weights()

        ###############
        # 初始化样本生成器
        if self.is_training:
            # 如果是在训练模式下
            training_data_src_path = (
                self.training_data_src_path  # 使用指定的训练数据源路径
                if not self.pretrain  # 如果不是在预训练模式
                else self.get_pretraining_data_path()  # 否则使用预训练数据路径
            )
            training_data_dst_path = (
                self.training_data_dst_path  # 使用指定的目标训练数据路径
                if not self.pretrain  # 如果不是在预训练模式
                else self.get_pretraining_data_path()  # 否则使用预训练数据路径
            )
            # 如果指定了ct_mode并且不是预训练模式，则使用目标训练数据路径
            random_ct_samples_path = (
                training_data_dst_path
                if ct_mode is not None and not self.pretrain
                else None  # 否则不使用任何路径
            )

            # 获取CPU核心数，但不超过设定的上限
            cpu_count = min(multiprocessing.cpu_count(), self.options["cpu_cap"])
            src_generators_count = cpu_count // 2  # 源数据生成器的数量为CPU核心数的一半
            dst_generators_count = (
                cpu_count // 2
            )  # 目标数据生成器的数量也是CPU核心数的一半
            if ct_mode is not None:
                src_generators_count = int(
                    src_generators_count * 1.5
                )  # 如果指定了ct_mode，则增加源数据生成器的数量

            dst_aug = None  # 初始化目标数据增强为None
            allowed_dst_augs = ["fs-aug", "cc-aug"]  # 定义允许的目标数据增强类型
            if ct_mode in allowed_dst_augs:
                dst_aug = ct_mode  # 如果ct_mode是允许的类型，则使用该类型的数据增强

            channel_type = (
                SampleProcessor.ChannelType.LAB_RAND_TRANSFORM  # 如果开启了随机颜色选项
                if self.options["random_color"]
                else SampleProcessor.ChannelType.BGR  # 否则使用BGR通道类型
            )


            ignore_same_path = False
            if (
                self.src_pak_name != self.dst_pak_name
                and training_data_src_path == training_data_dst_path
                and not self.pretrain
            ):
                ignore_same_path = True
            elif self.pretrain:
                self.src_pak_name = self.dst_pak_name = "faceset"

            # print("test super warp",self.rotation_range,self.scale_range)
            self.set_training_data_generators(
                [
                    SampleGeneratorFace(
                        training_data_src_path,
                        pak_name=self.src_pak_name,
                        ignore_same_path=ignore_same_path,
                        random_ct_samples_path=random_ct_samples_path,
                        debug=self.is_debug(),
                        batch_size=self.get_batch_size(),
                        sample_process_options=SampleProcessor.Options(
                            rotation_range=self.rotation_range,
                            scale_range=self.scale_range,
                            random_flip=random_src_flip,
                        ),
                        output_sample_types=[
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": random_warp,
                                "random_downsample": self.options["random_downsample"],
                                "random_noise": self.options["random_noise"],
                                "random_blur": self.options["random_blur"],
                                "random_jpeg": self.options["random_jpeg"],
                                "random_hsv_shift_amount": random_hsv_power,
                                "transform": True,
                                "channel_type": channel_type,
                                "ct_mode": ct_mode,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": False,
                                "transform": True,
                                "channel_type": channel_type,
                                "ct_mode": ct_mode,
                                "random_hsv_shift_amount": random_hsv_power,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_MASK,
                                "warp": False,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.G,
                                "face_mask_type": SampleProcessor.FaceMaskType.FULL_FACE,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_MASK,
                                "warp": False,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.G,
                                "face_mask_type": SampleProcessor.FaceMaskType.EYES_MOUTH,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                        ],
                        uniform_yaw_distribution=self.options["uniform_yaw"]
                        or self.pretrain,
                        generators_count=src_generators_count,
                    ),
                    SampleGeneratorFace(
                        training_data_dst_path,
                        pak_name=self.dst_pak_name,
                        ignore_same_path=ignore_same_path,
                        debug=self.is_debug(),
                        batch_size=self.get_batch_size(),
                        sample_process_options=SampleProcessor.Options(
                            rotation_range=self.rotation_range,
                            scale_range=self.scale_range,
                            random_flip=random_src_flip,
                        ),
                        output_sample_types=[
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": random_warp,
                                "random_downsample": self.options["random_downsample"],
                                "random_noise": self.options["random_noise"],
                                "random_blur": self.options["random_blur"],
                                "random_jpeg": self.options["random_jpeg"],
                                "transform": True,
                                "channel_type": channel_type,
                                "ct_mode": dst_aug,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": False,
                                "transform": True,
                                "channel_type": channel_type,
                                "ct_mode": dst_aug,
                                "random_hsv_shift_amount": random_hsv_power,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_MASK,
                                "warp": False,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.G,
                                "face_mask_type": SampleProcessor.FaceMaskType.FULL_FACE,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_MASK,
                                "warp": False,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.G,
                                "face_mask_type": SampleProcessor.FaceMaskType.EYES_MOUTH,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                        ],
                        uniform_yaw_distribution=self.options["uniform_yaw"]
                        or self.pretrain,
                        generators_count=dst_generators_count,
                    ),
                ]
            )

            if self.pretrain_just_disabled:
                self.update_sample_for_preview(force_new=True)

    def export_dfm(self):
        output_path = self.get_strpath_storage_for_file("model.dfm")

        io.log_info(f"导出 .dfm 到 {output_path}")

        tf = nn.tf
        nn.set_data_format("NCHW")

        with tf.device(nn.tf_default_device_name):
            warped_dst = tf.placeholder(
                nn.floatx, (None, self.resolution, self.resolution, 3), name="in_face"
            )
            warped_dst = tf.transpose(warped_dst, (0, 3, 1, 2))

            if "df" in self.archi_type:
                gpu_dst_code = self.inter(self.encoder(warped_dst))
                gpu_pred_src_dst, gpu_pred_src_dstm = self.decoder_src(gpu_dst_code)
                _, gpu_pred_dst_dstm = self.decoder_dst(gpu_dst_code)

            elif "liae" in self.archi_type:
                gpu_dst_code = self.encoder(warped_dst)
                gpu_dst_inter_B_code = self.inter_B(gpu_dst_code)
                gpu_dst_inter_AB_code = self.inter_AB(gpu_dst_code)
                gpu_dst_code = tf.concat(
                    [gpu_dst_inter_B_code, gpu_dst_inter_AB_code], nn.conv2d_ch_axis
                )
                gpu_src_dst_code = tf.concat(
                    [gpu_dst_inter_AB_code, gpu_dst_inter_AB_code], nn.conv2d_ch_axis
                )

                gpu_pred_src_dst, gpu_pred_src_dstm = self.decoder(gpu_src_dst_code)
                _, gpu_pred_dst_dstm = self.decoder(gpu_dst_code)

            gpu_pred_src_dst = tf.transpose(gpu_pred_src_dst, (0, 2, 3, 1))
            gpu_pred_dst_dstm = tf.transpose(gpu_pred_dst_dstm, (0, 2, 3, 1))
            gpu_pred_src_dstm = tf.transpose(gpu_pred_src_dstm, (0, 2, 3, 1))

        tf.identity(gpu_pred_dst_dstm, name="out_face_mask")
        tf.identity(gpu_pred_src_dst, name="out_celeb_face")
        tf.identity(gpu_pred_src_dstm, name="out_celeb_face_mask")

        output_graph_def = tf.graph_util.convert_variables_to_constants(
            nn.tf_sess,
            tf.get_default_graph().as_graph_def(),
            ["out_face_mask", "out_celeb_face", "out_celeb_face_mask"],
        )

        import tf2onnx

        with tf.device("/CPU:0"):
            model_proto, _ = tf2onnx.convert._convert_common(
                output_graph_def,
                name="ShenNong",
                input_names=["in_face:0"],
                output_names=[
                    "out_face_mask:0",
                    "out_celeb_face:0",
                    "out_celeb_face_mask:0",
                ],
                opset=12,
                output_path=output_path,
            )

    # override
    def get_model_filename_list(self):
        return self.model_filename_list

    # override
    def onSave(self):
        for model, filename in io.progress_bar_generator(
            self.get_model_filename_list(), "保存中...", leave=False
        ):
            model.save_weights(self.get_strpath_storage_for_file(filename))

    # override
    def should_save_preview_history(self):
        return (
            not io.is_colab()
            and self.iter % (10 * (max(1, self.resolution // 64))) == 0
        ) or (io.is_colab() and self.iter % 100 == 0)

    # override
    def onTrainOneIter(self):
        if (
            self.is_first_run()
            and not self.pretrain
            and not self.pretrain_just_disabled
        ):
            io.log_info("您正在从头开始训练模型。\n")

        (
            (warped_src, target_src, target_srcm, target_srcm_em),
            (warped_dst, target_dst, target_dstm, target_dstm_em),
        ) = self.generate_next_samples()

        src_loss, dst_loss = self.src_dst_train(
            warped_src,
            target_src,
            target_srcm,
            target_srcm_em,
            warped_dst,
            target_dst,
            target_dstm,
            target_dstm_em,
        )

        if self.options["true_face_power"] != 0 and not self.pretrain:
            self.D_train(warped_src, warped_dst)

        if self.gan_power != 0:
            self.D_src_dst_train(
                warped_src,
                target_src,
                target_srcm,
                target_srcm_em,
                warped_dst,
                target_dst,
                target_dstm,
                target_dstm_em,
            )

        return (
            ("src_loss", np.mean(src_loss)),
            ("dst_loss", np.mean(dst_loss)),
        )

    # override
    def onGetPreview(self, samples, for_history=False, filenames=None):
        (
            (warped_src, target_src, target_srcm, target_srcm_em),
            (warped_dst, target_dst, target_dstm, target_dstm_em),
        ) = samples

        S, D, SS, SSM, DD, DDM, SD, SDM = [
            np.clip(nn.to_data_format(x, "NHWC", self.model_data_format), 0.0, 1.0)
            for x in ([target_src, target_dst] + self.AE_view(target_src, target_dst))
        ]
        SW, DW = [
            np.clip(nn.to_data_format(x, "NHWC", self.model_data_format), 0.0, 1.0)
            for x in ([warped_src, warped_dst])
        ]
        (
            SSM,
            DDM,
            SDM,
        ) = [np.repeat(x, (3,), -1) for x in [SSM, DDM, SDM]]

        target_srcm, target_dstm = [
            nn.to_data_format(x, "NHWC", self.model_data_format)
            for x in ([target_srcm, target_dstm])
        ]

        n_samples = min(self.get_batch_size(), self.options["preview_samples"])

        if filenames is not None and len(filenames) > 0:
            for i in range(n_samples):
                S[i] = label_face_filename(S[i], filenames[0][i])
                D[i] = label_face_filename(D[i], filenames[1][i])


        result = []

        st = []
        for i in range(n_samples):
            ar = S[i], SS[i], D[i], DD[i], SD[i]
            st.append(np.concatenate(ar, axis=1))
        result += [
            ("Quick384", np.concatenate(st, axis=0)),
        ]


        st_m = []
        for i in range(n_samples):
            SD_mask = DDM[i] * SDM[i] if self.face_type < FaceType.HEAD else SDM[i]
            SM = S[i] * target_srcm[i]
            DM = D[i] * target_dstm[i]
            if filenames is not None and len(filenames) > 0:
                SM = label_face_filename(SM, filenames[0][i])
                DM = label_face_filename(DM, filenames[1][i])
            ar = SM, SS[i] * SSM[i], DM, DD[i] * DDM[i], SD[i] * SD_mask
            st_m.append(np.concatenate(ar, axis=1))

        result += [
            ("Quick384 masked", np.concatenate(st_m, axis=0)),
        ]
        
        return result

    def predictor_func(self, face=None):
        face = nn.to_data_format(face[None, ...], self.model_data_format, "NHWC")

        bgr, mask_dst_dstm, mask_src_dstm = [
            nn.to_data_format(x, "NHWC", self.model_data_format).astype(np.float32)
            for x in self.AE_merge(face)
        ]

        return bgr[0], mask_src_dstm[0][..., 0], mask_dst_dstm[0][..., 0]

    # override
    def get_MergerConfig(self):
        import merger

        return (
            self.predictor_func,
            (384, 384, 3),
            merger.MergerConfigMasked(face_type=self.face_type, default_mode="overlay"),
        )



Model = MEModel
