import multiprocessing
import operator
import os
import sys
import time
from functools import partial
from pathlib import Path
from mainscripts.Trainer import global_mean_loss
import numpy as np

from core import mathlib
from core.interact import interact as io
from core.leras import nn
from facelib import FaceType
from models import ModelBase
from samplelib import *


class SAEHDModel(ModelBase):
    # override
    def on_initialize_options(self):
        device_config = nn.getCurrentDeviceConfig()
        
        lowest_vram = 2
        if len(device_config.devices) != 0:
            lowest_vram = device_config.devices.get_worst_device().total_mem_gb

        if lowest_vram >= 4:
            suggest_batch_size = 8
        else:
            suggest_batch_size = 4

        yn_str = {True: "y", False: "n"}
        min_res = 64
        max_res = 640
        
        # 有的default开头 都是为了在input时显示一个默认推荐值，优先读取option，其次读取上次创建模型的def_option，两者都空，才是常量。
        default_resolution = self.options["resolution"] = self.load_or_def_option(
            "resolution", 256
        )
        default_face_type = self.options["face_type"] = self.load_or_def_option(
            "face_type", "wf"
        )
        default_models_opt_on_gpu = self.options[
            "models_opt_on_gpu"
        ] = self.load_or_def_option("models_opt_on_gpu", True)

        default_archi = self.options["archi"] = self.load_or_def_option(
            "archi", "df-d"
        )

        default_ae_dims = self.options["ae_dims"] = self.load_or_def_option(
            "ae_dims", 128
        )
        default_e_dims = self.options["e_dims"] = self.load_or_def_option("e_dims", 48)
        default_d_dims = self.options["d_dims"] = self.load_or_def_option("d_dims", 48)

        default_d_mask_dims = default_d_dims // 3
        default_d_mask_dims += default_d_mask_dims % 2
        default_d_mask_dims = self.options["d_mask_dims"] = self.load_or_def_option("d_mask_dims", default_d_mask_dims)
        
        default_masked_training = self.options[
            "masked_training"
        ] = self.load_or_def_option("masked_training", True)
        default_eyes_mouth_prio = self.options[
            "eyes_mouth_prio"
        ] = self.load_or_def_option("eyes_mouth_prio", False)
        default_uniform_yaw = self.options["uniform_yaw"] = self.load_or_def_option(
            "uniform_yaw", True
        )
        default_blur_out_mask = self.options["blur_out_mask"] = self.load_or_def_option(
            "blur_out_mask", False
        )

        default_adabelief = self.options["adabelief"] = self.load_or_def_option(
            "adabelief", True
        )
        
        self.options["loss_src"]=self.load_or_def_option(
            "loss_src", "未记录2"
        )
        self.options["loss_dst"]=self.load_or_def_option(
            "loss_dst", "未记录2"
        )
        
        lr_dropout = self.load_or_def_option("lr_dropout", "n")
        lr_dropout = {True: "y", False: "n"}.get(
            lr_dropout, lr_dropout
        )  # backward comp
        default_lr_dropout = self.options["lr_dropout"] = lr_dropout

        default_random_warp = self.options["random_warp"] = self.load_or_def_option(
            "random_warp", True
        )
        default_random_hsv_power = self.options[
            "random_hsv_power"
        ] = self.load_or_def_option("random_hsv_power", 0.0)
        default_true_face_power = self.options[
            "true_face_power"
        ] = self.load_or_def_option("true_face_power", 0.0)
        default_face_style_power = self.options[
            "face_style_power"
        ] = self.load_or_def_option("face_style_power", 0.0)
        default_bg_style_power = self.options[
            "bg_style_power"
        ] = self.load_or_def_option("bg_style_power", 0.0)
        default_ct_mode = self.options["ct_mode"] = self.load_or_def_option(
            "ct_mode", "none"
        )
        default_clipgrad = self.options["clipgrad"] = self.load_or_def_option(
            "clipgrad", False
        )
        default_pretrain = self.options["pretrain"] = self.load_or_def_option(
            "pretrain", False
        )
        default_gan_power = self.options["gan_power"] = self.load_or_def_option(
            "gan_power", 0.0
        )
        default_gan_patch_size = self.options[
            "gan_patch_size"
        ] = self.load_or_def_option("gan_patch_size", self.options["resolution"] // 8)
        default_gan_dims = self.options["gan_dims"] = self.load_or_def_option(
            "gan_dims", 16
        )
        ask_override = self.ask_override = self.ask_override()
        
        default_retraining_samples = self.options["retraining_samples"] = self.load_or_def_option('retraining_samples', False)
 
        
        # 创建模型首次选项
        if self.is_first_run():
            
            self.options["face_type"] = io.input_str(
                "脸类型 face_type",
                default_face_type,
                ["h", "mf", "f", "wf", "head"],
                help_message="半脸/中脸/全脸/整脸/头。 半脸具有更好的分辨率，但覆盖的脸颊区域较少。 中面比半面宽 30%。 “整脸”覆盖整个面部区域，包括前额。 'head' 覆盖整个头部，但需要 XSeg 应用于 src 和 dst 人脸数据集.",
            ).lower()
            
            self.options["autobackup_hour"] = 0
            self.options["write_preview_history"] = False
            self.options["target_iter"] = 0
            self.options["random_dst_flip"] = True
            self.options["batch_size"] = 4
            self.options["lr_dropout"] = "n"
            self.options["eyes_mouth_prio"] = False
            self.options["uniform_yaw"] = True
            self.options["blur_out_mask"] = False
            self.options["true_face_power"] = 0.0
            self.options["face_style_power"] = 0.0
            self.options["bg_style_power"] = 0.0
            self.options["random_hsv_power"] = 0.0

            resolution = io.input_int(
                "分辨率 resolution",
                default_resolution,
                add_info="64-640",
                help_message="更高的分辨率需要更多的 VRAM 和训练时间。 -d 结构的值将调整为 16 和 32 的倍数。.",
            )
            resolution = np.clip((resolution // 16) * 16, min_res, max_res)
            self.options["resolution"] = resolution


            while True:
                archi = io.input_str(
                    "AE架构 AE architecture",
                    default_archi,
                    help_message="""
                            'df' 保持更多身份特征的脸部（更像SRC）。
                            'liae' 可以修复过于不同的脸部形状（更像DST）。
                            '-u' 增加与源人脸（SRC）的相似度，需要更多 VRAM。
                            '-d' 计算成本减半。需要更长的训练时间，并建议使用预训练模型。分辨率必须按 32 的倍数更改
							'-t' 增加与源人脸（SRC）的相似度。
							'-c' （实验性）将激活函数设置为余弦单位（默认值：Leaky ReLu）。
                            示例: df, liae-d, df-dt, liae-udt, ...
                            """,
                ).lower()

                archi_split = archi.split("-")

                if len(archi_split) == 2:
                    archi_type, archi_opts = archi_split
                elif len(archi_split) == 1: # 其实archi_split[0] = archi
                    archi_type, archi_opts = archi_split[0], None
                else:
                    continue

                if archi_type not in ["df", "liae"]:
                    continue

                if archi_opts is not None:
                    if len(archi_opts) == 0:
                        continue
                    if (
                        len(
                            [1 for opt in archi_opts if opt not in ["u", "d", "t", "c"]]
                        )
                        != 0
                    ):
                        continue

                    if "d" in archi_opts:
                        self.options["resolution"] = np.clip(
                            (self.options["resolution"] // 32) * 32, min_res, max_res
                        )

                break
            self.options["archi"] = archi
            
            self.options["ae_dims"] = np.clip(
                io.input_int(
                    "自动编码器大小 AutoEncoder dimensions",
                    default_ae_dims,
                    add_info="32-1024",
                    help_message="所有面部信息都将打包到自动编码器中. 如果自动编码器的数量不够，则例如无法识别闭眼. 更高的值更好，但需要更多的 VRAM. 您可以微调模型大小以适合您的 GPU.",
                ),
                32,
                1024,
            )

            e_dims = np.clip(
                io.input_int(
                    "编码器大小 Encoder dimensions",
                    default_e_dims,
                    add_info="16-256",
                    help_message="更多的编码器有助于识别更多的面部特征并获得更清晰的结果，但需要更多的 VRAM。 您可以微调模型大小以适合您的 GPU.",
                ),
                16,
                256,
            )
            self.options["e_dims"] = e_dims + e_dims % 2

            d_dims = np.clip(
                io.input_int(
                    "解码器大小 Decoder dimensions",
                    default_d_dims,
                    add_info="16-256",
                    help_message="更多的解码器有助于识别更多的面部特征并获得更清晰的结果，但需要更多的 VRAM。 您可以微调模型大小以适合您的 GPU..",
                ),
                16,
                256,
            )
            self.options["d_dims"] = d_dims + d_dims % 2

            d_mask_dims = np.clip(
                io.input_int(
                    "遮罩解码器大小 Decoder mask dimensions",
                    default_d_mask_dims,
                    add_info="2-256",
                    help_message="典型的掩码尺寸 = 解码器尺寸/3。如果您手动从 dst 掩码中切出障碍物，您可以增加此参数以获得更好的质量.",
                ),
                2,
                256,
            )
            self.options["d_mask_dims"] = d_mask_dims + d_mask_dims % 2  
            self.options["adabelief"] = io.input_bool(
                "使用AdaBelief优化器? Use AdaBelief optimizer?",
                default_adabelief,
                help_message="使用 AdaBelief 优化器。 它需要更多的显存，但模型的准确性和泛化性更高.",
            )            
            self.ask_random_src_flip()
      
            
        # 复训的时候询问：
        if ask_override:
            self.ask_autobackup_hour()
            self.ask_write_preview_history()
            self.ask_target_iter()
            self.ask_random_src_flip()
            self.ask_random_dst_flip()
            self.ask_batch_size(suggest_batch_size)
            self.options["lr_dropout"] = io.input_str(
                f"使用学习率下降 Use learning rate dropout",
                default_lr_dropout,
                ["n", "y", "cpu"],
                help_message="当面部训练足够时，您可以启用此选项以获得额外的清晰度并减少亚像素抖动以减少迭代次数。 在“禁用随机扭曲”和 GAN 之前启用它。 \nn - 禁用。\ny - 启用\ncpu - 在 CPU 上启用。 这允许不使用额外的 VRAM，牺牲 20% 的迭代时间.",
            )            
            self.options["eyes_mouth_prio"] = io.input_bool(
                "眼睛和嘴巴优先 Eyes and mouth priority",
                default_eyes_mouth_prio,
                help_message="有助于解决训练期间的眼部问题，如“异眼”和错误的眼睛方向。 也让牙齿的细节更高.",
            )
            self.options["uniform_yaw"] = io.input_bool(
                "侧脸优化 Uniform yaw distribution of samples",
                default_uniform_yaw,
                help_message="由于faceset中的侧脸数量很少，因此有助于修复模糊的侧脸.",
            )
            self.options["blur_out_mask"] = io.input_bool(
                "模糊遮罩边缘 Blur out mask",
                default_blur_out_mask,
                help_message="模糊训练样本应用面罩外的附近区域。 结果是脸部附近的背景变得平滑并且在交换的脸部上不太明显。 src 和 dst 必须有 xseg 遮罩.",
            )
            self.options["random_hsv_power"] = np.clip(
                io.input_number(
                    "随机色调/饱和度/光强度",
                    default_random_hsv_power,
                    add_info="0.0 .. 0.3",
                    help_message="随机色调/饱和度/光强度仅在神经网络的输入端应用于 src 人脸集。 在面部交换期间稳定颜色扰动。 通过选择 src faceset 中最接近的颜色来降低颜色转移的质量。 因此 src faceset 必须足够多样化。 典型值为 0.05",
                ),
                0.0,
                0.3,
            )            
            
            if self.options["pretrain"] == False:
                self.options["gan_power"] = np.clip(
                    io.input_number(
                        "GAN强度 GAN power",
                        default_gan_power,
                        add_info="0.0 .. 5.0",
                        help_message="强制神经网络学习面部的小细节。 仅当使用 学习率下降(on) 和 关闭随机扭曲 对面部进行了足够的训练时才启用它，并且不要禁用。 值越高，出现崩溃的机会就越大。 典型值为 0.1",
                    ),
                    0.0,
                    5.0,
                )

                if self.options["gan_power"] != 0.0:
                    gan_patch_size = np.clip(
                        io.input_int(
                            "gan补丁大小 GAN patch size",
                            default_gan_patch_size,
                            add_info="3-640",
                            help_message="补丁大小越大，质量越高，需要的 VRAM 也越多。 即使在最低设置下，您也可以获得更清晰的边缘. 典型的精细值是分辨率/8.",
                        ),
                        3,
                        640,
                    )
                    self.options["gan_patch_size"] = gan_patch_size

                    gan_dims = np.clip(
                        io.input_int(
                            "GAN维度 GAN dimensions",
                            default_gan_dims,
                            add_info="4-512",
                            help_message="GAN 网络的维度。 维度越高，需要的 VRAM 就越多。 即使在最低设置下，您也可以获得更清晰的边缘。 典型值为 16.",
                        ),
                        4,
                        512,
                    )
                    self.options["gan_dims"] = gan_dims

                if "df" in self.options["archi"]:
                    self.options["true_face_power"] = np.clip(
                        io.input_number(
                            "'真脸强度 True face' power.",
                            default_true_face_power,
                            add_info="0.0000 .. 1.0",
                            help_message="实验选项。 区分结果面更像 src， 值越高越相似。 典型值为 0.01 " ,
                        ),
                        0.0,
                        1.0,
                    )
                else:
                    self.options["true_face_power"] = 0.0

                self.options["face_style_power"] = np.clip(
                    io.input_number(
                        "人脸风格强度 Face style power",
                        default_face_style_power,
                        add_info="0.0..100.0",
                        help_message="学习预测人脸的颜色与蒙版内的 dst 相同。 如果您想将此选项与 'WF' 一起使用，您必须使用 XSeg 训练的掩码。 警告：仅在 10k 迭代后启用它，当预测的人脸足够清晰以开始学习风格时。 从 0.001 值开始并检查历史更改。 启用此选项会增加模型崩溃的机会.",
                    ),
                    0.0,
                    100.0,
                )
                self.options["bg_style_power"] = np.clip(
                    io.input_number(
                        "背景风格强度 Background style power",
                        default_bg_style_power,
                        add_info="0.0..100.0",
                        help_message="学习预测人脸的mask外区域与dst相同。 如果您想将此选项与 'WF' 一起使用，您必须使用 XSeg 训练的掩码。这可以使脸更像 dst。 启用此选项会增加模型崩溃的机会。 从 0.01 值开始",
                    ),
                    0.0,
                    100.0,
                )

        # 公共选项（本地机器配置）
        if self.is_first_run() or ask_override:
            self.options["models_opt_on_gpu"] = io.input_bool(
                "将模型和优化器放在GPU上运行 Place models and optimizer on GPU",
                default_models_opt_on_gpu,
                help_message="当您在一个 GPU 上训练时，默认情况下模型和优化器权重被放置在 GPU 上以加速该过程。 您可以将它们放在 CPU 上以释放额外的 VRAM，从而设置更大的尺寸.",
            )

            if self.options["face_type"] == "wf" or self.options["face_type"] == "head":
                self.options["masked_training"] = io.input_bool(
                    "训练遮罩内的人脸 Masked training",
                    default_masked_training,
                    help_message="此选项仅适用于 'WF' 或 'head' 脸型。 Masked training 将训练区域剪辑为 full_face mask 或 XSeg mask，从而网络将正确训练人脸.",
                )

            self.options["random_warp"] = io.input_bool(
                "随机扭曲 Enable random warp of samples",
                default_random_warp,
                help_message="需要随机扭曲来概括两张脸的面部表情。 当面部训练足够时，您可以禁用它以获得额外的清晰度并减少亚像素抖动以减少迭代次数.",
            )

            self.options["ct_mode"] = io.input_str(
                f"颜色转换模式 Color transfer for src faceset",
                default_ct_mode,
                ["none", "rct", "lct", "mkl", "idt", "sot"],
                help_message="更改接近 dst 样本的 src 样本的颜色分布。 尝试所有模式以找到最好的，一般填none.",
            )
            
            self.ask_retraining_samples()
            
            self.options["clipgrad"] = io.input_bool(
                "启用梯度剪裁 Enable gradient clipping",
                default_clipgrad,
                help_message="梯度裁剪减少了模型崩溃的机会，牺牲了训练速度.",
            )
            self.options["pretrain"] = io.input_bool(
                    "启用预训练",
                    default_pretrain,
                    help_message="用大量的各种人脸预训练模型。 之后，模型可以用于更快地训练deepfake。 强制 random_flips=Y，gan_power=0.0，styles=0.0，uniform_yaw=Y",
                )  
            
        if self.author_name == "":
            self.ask_author_name()
            
            
        self.gan_model_changed = (
            default_gan_patch_size != self.options["gan_patch_size"]
        ) or (default_gan_dims != self.options["gan_dims"])

        self.pretrain_just_disabled = (
            default_pretrain == True and self.options["pretrain"] == False
        )

    # override
    def on_initialize(self):
        device_config = nn.getCurrentDeviceConfig()
        devices = device_config.devices
        self.model_data_format = (
            "NCHW" if len(devices) != 0 and not self.is_debug() else "NHWC"
        )
        nn.initialize(data_format=self.model_data_format)
        tf = nn.tf

        self.resolution = resolution = self.options["resolution"]
        self.face_type = {
            "h": FaceType.HALF,
            "mf": FaceType.MID_FULL,
            "f": FaceType.FULL,
            "wf": FaceType.WHOLE_FACE,
            "head": FaceType.HEAD,
        }[self.options["face_type"]]

        if "eyes_prio" in self.options:
            self.options.pop("eyes_prio")

        eyes_mouth_prio = self.options["eyes_mouth_prio"]

        archi_split = self.options["archi"].split("-")

        if len(archi_split) == 2:
            archi_type, archi_opts = archi_split
        elif len(archi_split) == 1:
            archi_type, archi_opts = archi_split[0], None

        self.archi_type = archi_type

        ae_dims = self.options["ae_dims"]
        e_dims = self.options["e_dims"]
        d_dims = self.options["d_dims"]
        d_mask_dims = self.options["d_mask_dims"]
        self.pretrain = self.options["pretrain"]
        if self.pretrain_just_disabled:
            self.set_iter(0)

        adabelief = self.options["adabelief"]

        use_fp16 = False
        if self.is_exporting:
            use_fp16 = io.input_bool(
                "导出量化 Export quantized?", False, help_message="使导出的模型更快。 如果您有问题，请禁用此选项."
            )

        
        # 设置相关参数 （已解锁预训练的所有锁定）
        self.gan_power = gan_power = 0.0 if self.pretrain else self.options["gan_power"]    
        random_warp = self.options["random_warp"]
        random_src_flip = self.random_src_flip
        random_dst_flip = self.random_dst_flip
        random_hsv_power = self.options["random_hsv_power"]
        blur_out_mask = self.options["blur_out_mask"]

        # 如果处于预训练阶段，调整一些参数设置（已解RW\flip\hsv\blur,保留gan和style的限制）
        if self.pretrain:
            self.options_show_override["gan_power"] = 0.0
            self.options_show_override["face_style_power"] = 0.0
            self.options_show_override["bg_style_power"] = 0.0

        masked_training = self.options["masked_training"]
        ct_mode = self.options["ct_mode"]
        if ct_mode == "none":
            ct_mode = None

        models_opt_on_gpu = (
            False if len(devices) == 0 else self.options["models_opt_on_gpu"]
        )
        models_opt_device = (
            nn.tf_default_device_name
            if models_opt_on_gpu and self.is_training
            else "/CPU:0"
        )
        optimizer_vars_on_cpu = models_opt_device == "/CPU:0"

        input_ch = 3
        bgr_shape = self.bgr_shape = nn.get4Dshape(resolution, resolution, input_ch)
        mask_shape = nn.get4Dshape(resolution, resolution, 1)
        self.model_filename_list = []

        with tf.device("/CPU:0"):
            # Place holders on CPU
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

        # Initializing model classes
        model_archi = nn.DeepFakeArchi(resolution, use_fp16=use_fp16, opts=archi_opts)

        with tf.device(models_opt_device):
            if "df" in archi_type:
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

                if self.is_training:
                    if self.options["true_face_power"] != 0:
                        self.code_discriminator = nn.CodeDiscriminator(
                            ae_dims, code_res=self.inter.get_out_res(), name="dis"
                        )
                        self.model_filename_list += [
                            [self.code_discriminator, "code_discriminator.npy"]
                        ]

            elif "liae" in archi_type:
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
                        patch_size=self.options["gan_patch_size"],
                        in_ch=input_ch,
                        base_ch=self.options["gan_dims"],
                        name="D_src",
                    )
                    self.model_filename_list += [[self.D_src, "GAN.npy"]]

                # Initialize optimizers
                lr = 5e-5
                if self.options["lr_dropout"] in ["y", "cpu"] and not self.pretrain:
                    lr_cos = 500
                    lr_dropout = 0.3
                else:
                    lr_cos = 0
                    lr_dropout = 1.0
                OptimizerClass = nn.AdaBelief if adabelief else nn.RMSprop
                clipnorm = 1.0 if self.options["clipgrad"] else 0.0

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

                if self.options["true_face_power"] != 0:
                    self.D_code_opt = OptimizerClass(
                        lr=lr,
                        lr_dropout=lr_dropout,
                        lr_cos=lr_cos,
                        clipnorm=clipnorm,
                        name="D_code_opt",
                    )
                    self.D_code_opt.initialize_variables(
                        self.code_discriminator.get_weights(),
                        vars_on_cpu=optimizer_vars_on_cpu,
                        lr_dropout_on_cpu=self.options["lr_dropout"] == "cpu",
                    )
                    self.model_filename_list += [(self.D_code_opt, "D_code_opt.npy")]

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
            # Adjust batch size for multiple GPU
            gpu_count = max(1, len(devices))
            bs_per_gpu = max(1, self.get_batch_size() // gpu_count)
            self.set_batch_size(gpu_count * bs_per_gpu)

            # Compute losses per GPU
            gpu_pred_src_src_list = []
            gpu_pred_dst_dst_list = []
            gpu_pred_src_dst_list = []
            gpu_pred_src_srcm_list = []
            gpu_pred_dst_dstm_list = []
            gpu_pred_src_dstm_list = []

            gpu_src_losses = []
            gpu_dst_losses = []
            gpu_G_loss_gvs = []
            gpu_D_code_loss_gvs = []
            gpu_D_src_dst_loss_gvs = []

            for gpu_id in range(gpu_count):
                with tf.device(
                    f"/{devices[gpu_id].tf_dev_type}:{gpu_id}"
                    if len(devices) != 0
                    else f"/CPU:0"
                ):
                    with tf.device(f"/CPU:0"):
                        # slice on CPU, otherwise all batch data will be transfered to GPU first
                        batch_slice = slice(
                            gpu_id * bs_per_gpu, (gpu_id + 1) * bs_per_gpu
                        )
                        gpu_warped_src = self.warped_src[batch_slice, :, :, :]
                        gpu_warped_dst = self.warped_dst[batch_slice, :, :, :]
                        gpu_target_src = self.target_src[batch_slice, :, :, :]
                        gpu_target_dst = self.target_dst[batch_slice, :, :, :]
                        gpu_target_srcm = self.target_srcm[batch_slice, :, :, :]
                        gpu_target_srcm_em = self.target_srcm_em[batch_slice, :, :, :]
                        gpu_target_dstm = self.target_dstm[batch_slice, :, :, :]
                        gpu_target_dstm_em = self.target_dstm_em[batch_slice, :, :, :]

                    gpu_target_srcm_anti = 1 - gpu_target_srcm
                    gpu_target_dstm_anti = 1 - gpu_target_dstm

                    if blur_out_mask:
                        sigma = resolution / 128

                        x = nn.gaussian_blur(
                            gpu_target_src * gpu_target_srcm_anti, sigma
                        )
                        y = 1 - nn.gaussian_blur(gpu_target_srcm, sigma)
                        y = tf.where(tf.equal(y, 0), tf.ones_like(y), y)
                        gpu_target_src = (
                            gpu_target_src * gpu_target_srcm
                            + (x / y) * gpu_target_srcm_anti
                        )

                        x = nn.gaussian_blur(
                            gpu_target_dst * gpu_target_dstm_anti, sigma
                        )
                        y = 1 - nn.gaussian_blur(gpu_target_dstm, sigma)
                        y = tf.where(tf.equal(y, 0), tf.ones_like(y), y)
                        gpu_target_dst = (
                            gpu_target_dst * gpu_target_dstm
                            + (x / y) * gpu_target_dstm_anti
                        )

                    # process model tensors
                    if "df" in archi_type:
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

                    gpu_pred_src_src_list.append(gpu_pred_src_src)
                    gpu_pred_dst_dst_list.append(gpu_pred_dst_dst)
                    gpu_pred_src_dst_list.append(gpu_pred_src_dst)

                    gpu_pred_src_srcm_list.append(gpu_pred_src_srcm)
                    gpu_pred_dst_dstm_list.append(gpu_pred_dst_dstm)
                    gpu_pred_src_dstm_list.append(gpu_pred_src_dstm)

                    gpu_target_srcm_blur = nn.gaussian_blur(
                        gpu_target_srcm, max(1, resolution // 32)
                    )
                    gpu_target_srcm_blur = (
                        tf.clip_by_value(gpu_target_srcm_blur, 0, 0.5) * 2
                    )
                    gpu_target_srcm_anti_blur = 1.0 - gpu_target_srcm_blur

                    gpu_target_dstm_blur = nn.gaussian_blur(
                        gpu_target_dstm, max(1, resolution // 32)
                    )
                    gpu_target_dstm_blur = (
                        tf.clip_by_value(gpu_target_dstm_blur, 0, 0.5) * 2
                    )

                    gpu_style_mask_blur = nn.gaussian_blur(
                        gpu_pred_src_dstm * gpu_pred_dst_dstm, max(1, resolution // 32)
                    )
                    gpu_style_mask_blur = tf.stop_gradient(
                        tf.clip_by_value(gpu_target_srcm_blur, 0, 1.0)
                    )
                    gpu_style_mask_anti_blur = 1.0 - gpu_style_mask_blur

                    gpu_target_dst_masked = gpu_target_dst * gpu_target_dstm_blur

                    gpu_target_src_anti_masked = (
                        gpu_target_src * gpu_target_srcm_anti_blur
                    )
                    gpu_pred_src_src_anti_masked = (
                        gpu_pred_src_src * gpu_target_srcm_anti_blur
                    )

                    gpu_target_src_masked_opt = (
                        gpu_target_src * gpu_target_srcm_blur
                        if masked_training
                        else gpu_target_src
                    )
                    gpu_target_dst_masked_opt = (
                        gpu_target_dst_masked if masked_training else gpu_target_dst
                    )
                    gpu_pred_src_src_masked_opt = (
                        gpu_pred_src_src * gpu_target_srcm_blur
                        if masked_training
                        else gpu_pred_src_src
                    )
                    gpu_pred_dst_dst_masked_opt = (
                        gpu_pred_dst_dst * gpu_target_dstm_blur
                        if masked_training
                        else gpu_pred_dst_dst
                    )

                    if resolution < 256:
                        gpu_src_loss = tf.reduce_mean(
                            10
                            * nn.dssim(
                                gpu_target_src_masked_opt,
                                gpu_pred_src_src_masked_opt,
                                max_val=1.0,
                                filter_size=int(resolution / 11.6),
                            ),
                            axis=[1],
                        )
                    else:
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

                    if eyes_mouth_prio:
                        gpu_src_loss += tf.reduce_mean(
                            300
                            * tf.abs(
                                gpu_target_src * gpu_target_srcm_em
                                - gpu_pred_src_src * gpu_target_srcm_em
                            ),
                            axis=[1, 2, 3],
                        )

                    gpu_src_loss += tf.reduce_mean(
                        10 * tf.square(gpu_target_srcm - gpu_pred_src_srcm),
                        axis=[1, 2, 3],
                    )

                    face_style_power = self.options["face_style_power"] / 100.0
                    if face_style_power != 0 and not self.pretrain:
                        gpu_src_loss += nn.style_loss(
                            gpu_pred_src_dst_no_code_grad
                            * tf.stop_gradient(gpu_pred_src_dstm),
                            tf.stop_gradient(gpu_pred_dst_dst * gpu_pred_dst_dstm),
                            gaussian_blur_radius=resolution // 8,
                            loss_weight=10000 * face_style_power,
                        )

                    bg_style_power = self.options["bg_style_power"] / 100.0
                    if bg_style_power != 0 and not self.pretrain:
                        gpu_target_dst_style_anti_masked = (
                            gpu_target_dst * gpu_style_mask_anti_blur
                        )
                        gpu_psd_style_anti_masked = (
                            gpu_pred_src_dst * gpu_style_mask_anti_blur
                        )

                        gpu_src_loss += tf.reduce_mean(
                            (10 * bg_style_power)
                            * nn.dssim(
                                gpu_psd_style_anti_masked,
                                gpu_target_dst_style_anti_masked,
                                max_val=1.0,
                                filter_size=int(resolution / 11.6),
                            ),
                            axis=[1],
                        )
                        gpu_src_loss += tf.reduce_mean(
                            (10 * bg_style_power)
                            * tf.square(
                                gpu_psd_style_anti_masked
                                - gpu_target_dst_style_anti_masked
                            ),
                            axis=[1, 2, 3],
                        )

                    if resolution < 256:
                        gpu_dst_loss = tf.reduce_mean(
                            10
                            * nn.dssim(
                                gpu_target_dst_masked_opt,
                                gpu_pred_dst_dst_masked_opt,
                                max_val=1.0,
                                filter_size=int(resolution / 11.6),
                            ),
                            axis=[1],
                        )
                    else:
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

                    if eyes_mouth_prio:
                        gpu_dst_loss += tf.reduce_mean(
                            300
                            * tf.abs(
                                gpu_target_dst * gpu_target_dstm_em
                                - gpu_pred_dst_dst * gpu_target_dstm_em
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

                    if self.options["true_face_power"] != 0:
                        gpu_src_code_d = self.code_discriminator(gpu_src_code)
                        gpu_src_code_d_ones = tf.ones_like(gpu_src_code_d)
                        gpu_src_code_d_zeros = tf.zeros_like(gpu_src_code_d)
                        gpu_dst_code_d = self.code_discriminator(gpu_dst_code)
                        gpu_dst_code_d_ones = tf.ones_like(gpu_dst_code_d)

                        gpu_G_loss += self.options["true_face_power"] * DLoss(
                            gpu_src_code_d_ones, gpu_src_code_d
                        )

                        gpu_D_code_loss = (
                            DLoss(gpu_dst_code_d_ones, gpu_dst_code_d)
                            + DLoss(gpu_src_code_d_zeros, gpu_src_code_d)
                        ) * 0.5

                        gpu_D_code_loss_gvs += [
                            nn.gradients(
                                gpu_D_code_loss, self.code_discriminator.get_weights()
                            )
                        ]

                    if gan_power != 0:
                        gpu_pred_src_src_d, gpu_pred_src_src_d2 = self.D_src(
                            gpu_pred_src_src_masked_opt
                        )

                        gpu_pred_src_src_d_ones = tf.ones_like(gpu_pred_src_src_d)
                        gpu_pred_src_src_d_zeros = tf.zeros_like(gpu_pred_src_src_d)

                        gpu_pred_src_src_d2_ones = tf.ones_like(gpu_pred_src_src_d2)
                        gpu_pred_src_src_d2_zeros = tf.zeros_like(gpu_pred_src_src_d2)

                        gpu_target_src_d, gpu_target_src_d2 = self.D_src(
                            gpu_target_src_masked_opt
                        )

                        gpu_target_src_d_ones = tf.ones_like(gpu_target_src_d)
                        gpu_target_src_d2_ones = tf.ones_like(gpu_target_src_d2)

                        gpu_D_src_dst_loss = (
                            DLoss(gpu_target_src_d_ones, gpu_target_src_d)
                            + DLoss(gpu_pred_src_src_d_zeros, gpu_pred_src_src_d)
                        ) * 0.5 + (
                            DLoss(gpu_target_src_d2_ones, gpu_target_src_d2)
                            + DLoss(gpu_pred_src_src_d2_zeros, gpu_pred_src_src_d2)
                        ) * 0.5

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

        # Loading/initializing all models/optimizers weights
        for model, filename in io.progress_bar_generator(
            self.model_filename_list, "初始化模型..."
        ):
            if self.pretrain_just_disabled:
                do_init = False
                if "df" in archi_type:
                    if model == self.inter:
                        do_init = True
                elif "liae" in archi_type:
                    if model == self.inter_AB or model == self.inter_B:
                        do_init = True
            else:
                do_init = self.is_first_run()
                if self.is_training and gan_power != 0 and model == self.D_src:
                    if self.gan_model_changed:
                        do_init = True

            if not do_init:
                do_init = not model.load_weights(
                    self.get_strpath_storage_for_file(filename)
                )

            if do_init:
                model.init_weights()

        ###############

        # initializing sample generators
        if self.is_training:
            training_data_src_path = (
                self.training_data_src_path
                if not self.pretrain
                else self.get_pretraining_data_path()
            )
            training_data_dst_path = (
                self.training_data_dst_path
                if not self.pretrain
                else self.get_pretraining_data_path()
            )

            random_ct_samples_path = (
                training_data_dst_path
                if ct_mode is not None and not self.pretrain
                else None
            )

            cpu_count = multiprocessing.cpu_count()
            src_generators_count = cpu_count // 2
            dst_generators_count = cpu_count // 2
            if ct_mode is not None:
                src_generators_count = int(src_generators_count * 1.5)

            self.set_training_data_generators(
                [
                    SampleGeneratorFace(
                        training_data_src_path,
                        random_ct_samples_path=random_ct_samples_path,
                        debug=self.is_debug(),
                        batch_size=self.get_batch_size(),
                        sample_process_options=SampleProcessor.Options(
                            scale_range=[-0.15, 0.15], random_flip=random_src_flip
                        ),
                        output_sample_types=[
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": random_warp,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.BGR,
                                "ct_mode": ct_mode,
                                "random_hsv_shift_amount": random_hsv_power,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": False,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.BGR,
                                "ct_mode": ct_mode,
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
                        debug=self.is_debug(),
                        batch_size=self.get_batch_size(),
                        sample_process_options=SampleProcessor.Options(
                            scale_range=[-0.15, 0.15], random_flip=random_dst_flip
                        ),
                        output_sample_types=[
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": random_warp,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.BGR,
                                "face_type": self.face_type,
                                "data_format": nn.data_format,
                                "resolution": resolution,
                            },
                            {
                                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                                "warp": False,
                                "transform": True,
                                "channel_type": SampleProcessor.ChannelType.BGR,
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

            if self.options["retraining_samples"]:
                self.last_src_samples_loss = []
                self.last_dst_samples_loss = []

            if self.pretrain_just_disabled:
                self.update_sample_for_preview(force_new=True)

    def evaluate_pose_probes(self):
        """Publish a deterministic, read-only evaluation snapshot.

        This method deliberately calls only AE_view. Optimizer/train functions are
        never invoked, and Trainer verifies iteration/loss invariants around it.
        """
        manifest_path = os.environ.get("DFL_WEB_EVAL_MANIFEST", "").strip()
        evaluation_root = os.environ.get("DFL_WEB_EVAL_ROOT", "").strip()
        model_key = os.environ.get("DFL_WEB_EVAL_MODEL_KEY", "").strip()
        if not manifest_path or not evaluation_root or not model_key:
            raise ValueError("Web evaluation is not configured for this training task")

        configured_webui_python = os.environ.get("DFL_WEBUI_PYTHON", "").strip()
        webui_python = (
            Path(configured_webui_python).resolve()
            if configured_webui_python
            else Path(os.environ.get("WORKSPACE", "")).resolve().parent / "webui" / "python"
        )
        if not webui_python.is_dir():
            raise ValueError("Web evaluation helper directory is unavailable")
        if str(webui_python) not in sys.path:
            sys.path.insert(0, str(webui_python))
        from training_evaluation import (
            AtomicEvaluationSnapshot,
            load_evaluation_manifest,
            reconstruction_metrics,
            swap_metrics,
        )

        manifest, probe_samples = load_evaluation_manifest(
            manifest_path,
            evaluation_root,
            model_key,
            {
                "src": self.training_data_src_path,
                "dst": self.training_data_dst_path,
            },
        )
        expected_model_name = "%s_SAEHD" % manifest["modelName"]
        if self.get_model_name() != expected_model_name:
            raise ValueError("Loaded SAEHD model does not match the evaluation manifest")

        process_options = SampleProcessor.Options(
            random_flip=False,
            rotation_range=[0, 0],
            scale_range=[0, 0],
            tx_range=[0, 0],
            ty_range=[0, 0],
        )
        output_types = [
            {
                "sample_type": SampleProcessor.SampleType.FACE_IMAGE,
                "warp": False,
                "transform": False,
                "channel_type": SampleProcessor.ChannelType.BGR,
                "face_type": self.face_type,
                "data_format": self.model_data_format,
                "resolution": self.resolution,
            },
            {
                "sample_type": SampleProcessor.SampleType.FACE_MASK,
                "warp": False,
                "transform": False,
                "channel_type": SampleProcessor.ChannelType.G,
                "face_mask_type": SampleProcessor.FaceMaskType.FULL_FACE,
                "face_type": self.face_type,
                "data_format": self.model_data_format,
                "resolution": self.resolution,
            },
            {
                "sample_type": SampleProcessor.SampleType.FACE_MASK,
                "warp": False,
                "transform": False,
                "channel_type": SampleProcessor.ChannelType.G,
                "face_mask_type": SampleProcessor.FaceMaskType.EYES_MOUTH,
                "face_type": self.face_type,
                "data_format": self.model_data_format,
                "resolution": self.resolution,
            },
        ]

        prepared = {}
        for side, directory in (
            ("src", self.training_data_src_path),
            ("dst", self.training_data_dst_path),
        ):
            loaded_samples = SampleLoader.load(SampleType.FACE, directory)
            by_name = {Path(sample.filename).name: sample for sample in loaded_samples}
            prepared[side] = []
            for probe in probe_samples[side]:
                sample = by_name.get(probe["name"])
                if sample is None:
                    raise ValueError("Evaluation sample is no longer available: %s" % probe["name"])
                image, full_mask, eyes_mouth_mask = SampleProcessor.process(
                    [sample],
                    process_options,
                    output_types,
                    False,
                )[0]
                prepared[side].append({
                    "probe": probe,
                    "image": image,
                    "full_mask": full_mask,
                    "eyes_mouth_mask": eyes_mouth_mask,
                })

        model_signature = {
            "class": "SAEHD",
            "resolution": int(self.resolution),
            "faceType": self.options["face_type"],
            "architecture": self.options["archi"],
            "dataFormat": self.model_data_format,
        }
        snapshot = AtomicEvaluationSnapshot(
            evaluation_root,
            model_key,
            manifest["manifestId"],
            int(self.get_iter()),
            model_signature,
        )
        deadline = time.monotonic() + 120.0
        batch_size = self.get_batch_size()
        sample_count = max(len(prepared["src"]), len(prepared["dst"]))

        def to_nhwc(value):
            return np.clip(
                nn.to_data_format(value, "NHWC", self.model_data_format),
                0.0,
                1.0,
            ).astype(np.float32)

        try:
            for offset in range(0, sample_count, batch_size):
                if time.monotonic() >= deadline:
                    raise TimeoutError("Web evaluation exceeded 120 seconds")
                real_src = prepared["src"][offset:offset + batch_size]
                real_dst = prepared["dst"][offset:offset + batch_size]
                src_batch = [
                    prepared["src"][(offset + index) % len(prepared["src"])]
                    for index in range(batch_size)
                ]
                dst_batch = [
                    prepared["dst"][(offset + index) % len(prepared["dst"])]
                    for index in range(batch_size)
                ]
                predictions = self.AE_view(
                    np.stack([item["image"] for item in src_batch]),
                    np.stack([item["image"] for item in dst_batch]),
                )
                pred_src_src, pred_dst_dst, pred_dst_dstm, pred_src_dst, pred_src_dstm = [
                    to_nhwc(value) for value in predictions
                ]
                src_images = to_nhwc(np.stack([item["image"] for item in src_batch]))
                dst_images = to_nhwc(np.stack([item["image"] for item in dst_batch]))
                src_masks = to_nhwc(np.stack([item["full_mask"] for item in src_batch]))
                dst_masks = to_nhwc(np.stack([item["full_mask"] for item in dst_batch]))
                src_eyes_mouth = to_nhwc(np.stack([item["eyes_mouth_mask"] for item in src_batch]))
                dst_eyes_mouth = to_nhwc(np.stack([item["eyes_mouth_mask"] for item in dst_batch]))

                for index, item in enumerate(real_src):
                    snapshot.add_sample(
                        item["probe"],
                        {
                            "input": src_images[index],
                            "reconstruction": pred_src_src[index],
                            "target-mask": src_masks[index],
                        },
                        {
                            "reconstruction": reconstruction_metrics(
                                src_images[index],
                                pred_src_src[index],
                                src_masks[index],
                                src_eyes_mouth[index],
                            ),
                        },
                    )
                for index, item in enumerate(real_dst):
                    snapshot.add_sample(
                        item["probe"],
                        {
                            "input": dst_images[index],
                            "reconstruction": pred_dst_dst[index],
                            "swap": pred_src_dst[index],
                            "target-mask": dst_masks[index],
                            "predicted-mask": pred_src_dstm[index],
                        },
                        {
                            "reconstruction": reconstruction_metrics(
                                dst_images[index],
                                pred_dst_dst[index],
                                dst_masks[index],
                                dst_eyes_mouth[index],
                                pred_dst_dstm[index],
                            ),
                            "swap": swap_metrics(
                                dst_images[index],
                                pred_src_dst[index],
                                dst_masks[index],
                                pred_src_dstm[index],
                            ),
                        },
                    )
            return snapshot.publish()
        except Exception:
            snapshot.abort()
            raise

    def export_dfm(self):
        output_path = self.get_strpath_storage_for_file("model.dfm")

        io.log_info(f"将 .dfm 转储到 {output_path}")

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
                name="SAEHD",
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
        
        self.options["loss_src"] =global_mean_loss.src
        self.options["loss_dst"] =global_mean_loss.dst

        for model, filename in io.progress_bar_generator(
            self.get_model_filename_list(), "模型保存中...", leave=False
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
            self.get_iter() == 0
            and not self.pretrain
            and not self.pretrain_just_disabled
        ):
            io.log_info("您正在从头开始训练模型。强烈建议使用预训练模型来加快训练速度并提高质量。.\n")

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

        if self.options["retraining_samples"]:
            bs = self.get_batch_size()

            for i in range(bs):
                self.last_src_samples_loss.append(
                    (target_src[i], target_srcm[i], target_srcm_em[i], src_loss[i])
                )
                self.last_dst_samples_loss.append(
                    (target_dst[i], target_dstm[i], target_dstm_em[i], dst_loss[i])
                )

            if len(self.last_src_samples_loss) > bs * 9:
                src_samples_loss = sorted(
                    self.last_src_samples_loss, key=operator.itemgetter(3), reverse=True
                )
                dst_samples_loss = sorted(
                    self.last_dst_samples_loss, key=operator.itemgetter(3), reverse=True
                )

                target_src = np.stack([x[0] for x in src_samples_loss[:bs]])
                target_srcm = np.stack([x[1] for x in src_samples_loss[:bs]])
                target_srcm_em = np.stack([x[2] for x in src_samples_loss[:bs]])

                target_dst = np.stack([x[0] for x in dst_samples_loss[:bs]])
                target_dstm = np.stack([x[1] for x in dst_samples_loss[:bs]])
                target_dstm_em = np.stack([x[2] for x in dst_samples_loss[:bs]])

                src_loss, dst_loss = self.src_dst_train(
                    target_src,
                    target_src,
                    target_srcm,
                    target_srcm_em,
                    target_dst,
                    target_dst,
                    target_dstm,
                    target_dstm_em,
                )
                self.last_src_samples_loss = []
                self.last_dst_samples_loss = []

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
    def onGetPreview(self, samples, for_history=False):
        (
            (warped_src, target_src, target_srcm, target_srcm_em),
            (warped_dst, target_dst, target_dstm, target_dstm_em),
        ) = samples

        S, D, SS, DD, DDM, SD, SDM = [
            np.clip(nn.to_data_format(x, "NHWC", self.model_data_format), 0.0, 1.0)
            for x in ([target_src, target_dst] + self.AE_view(target_src, target_dst))
        ]
        (
            DDM,
            SDM,
        ) = [np.repeat(x, (3,), -1) for x in [DDM, SDM]]

        target_srcm, target_dstm = [
            nn.to_data_format(x, "NHWC", self.model_data_format)
            for x in ([target_srcm, target_dstm])
        ]

        n_samples = min(4, self.get_batch_size(), 800 // self.resolution)

        if self.resolution <= 256:
            result = []

            st = []
            for i in range(n_samples):
                ar = S[i], SS[i], D[i], DD[i], SD[i]
                st.append(np.concatenate(ar, axis=1))
            result += [
                ("SAEHD", np.concatenate(st, axis=0)),
            ]

            st_m = []
            for i in range(n_samples):
                SD_mask = DDM[i] * SDM[i] if self.face_type < FaceType.HEAD else SDM[i]

                ar = (
                    S[i] * target_srcm[i],
                    SS[i],
                    D[i] * target_dstm[i],
                    DD[i] * DDM[i],
                    SD[i] * SD_mask,
                )
                st_m.append(np.concatenate(ar, axis=1))

            result += [
                ("SAEHD masked", np.concatenate(st_m, axis=0)),
            ]
        else:
            result = []

            st = []
            for i in range(n_samples):
                ar = S[i], SS[i]
                st.append(np.concatenate(ar, axis=1))
            result += [
                ("SAEHD src-src", np.concatenate(st, axis=0)),
            ]

            st = []
            for i in range(n_samples):
                ar = D[i], DD[i]
                st.append(np.concatenate(ar, axis=1))
            result += [
                ("SAEHD dst-dst", np.concatenate(st, axis=0)),
            ]

            st = []
            for i in range(n_samples):
                ar = D[i], SD[i]
                st.append(np.concatenate(ar, axis=1))
            result += [
                ("SAEHD pred", np.concatenate(st, axis=0)),
            ]

            st_m = []
            for i in range(n_samples):
                ar = S[i] * target_srcm[i], SS[i]
                st_m.append(np.concatenate(ar, axis=1))
            result += [
                ("SAEHD masked src-src", np.concatenate(st_m, axis=0)),
            ]

            st_m = []
            for i in range(n_samples):
                ar = D[i] * target_dstm[i], DD[i] * DDM[i]
                st_m.append(np.concatenate(ar, axis=1))
            result += [
                ("SAEHD masked dst-dst", np.concatenate(st_m, axis=0)),
            ]

            st_m = []
            for i in range(n_samples):
                SD_mask = DDM[i] * SDM[i] if self.face_type < FaceType.HEAD else SDM[i]
                ar = D[i] * target_dstm[i], SD[i] * SD_mask
                st_m.append(np.concatenate(ar, axis=1))
            result += [
                ("SAEHD masked pred", np.concatenate(st_m, axis=0)),
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
            (self.options["resolution"], self.options["resolution"], 3),
            merger.MergerConfigMasked(face_type=self.face_type, default_mode="overlay"),
        )


Model = SAEHDModel
