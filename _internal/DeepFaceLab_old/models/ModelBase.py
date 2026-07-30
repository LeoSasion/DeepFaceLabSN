import colorsys
import inspect
import json
import multiprocessing
import operator
import os
import pickle
import shutil
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

from core import imagelib, pathex
from core.cv2ex import *
from core.interact import interact as io
from core.leras import nn
from samplelib import SampleGeneratorBase
from prettytable import PrettyTable


class ModelBase(object):
    def __init__(self, is_training=False,
                       is_exporting=False,
                       saved_models_path=None,
                       training_data_src_path=None,
                       training_data_dst_path=None,
                       pretraining_data_path=None,
                       pretrained_model_path=None,
                       no_preview=False,
                       force_model_name=None,
                       force_gpu_idxs=None,
                       cpu_only=False,
                       debug=False,
                       force_model_class_name=None,
                       silent_start=False,
                       **kwargs):
        self.is_training = is_training
        self.is_exporting = is_exporting
        self.saved_models_path = saved_models_path
        self.training_data_src_path = training_data_src_path
        self.training_data_dst_path = training_data_dst_path
        self.pretraining_data_path = pretraining_data_path
        self.pretrained_model_path = pretrained_model_path
        self.no_preview = no_preview
        self.debug = debug
        self.author_name = "神农汉化"

        self.model_class_name = model_class_name = Path(inspect.getmodule(self).__file__).parent.name.rsplit("_", 1)[1]

        if force_model_class_name is None:
            if force_model_name is not None:
                self.model_name = force_model_name
            else:
                while True:
                    # 收集所有模型的数据文件
                    saved_models_names = []
                    for filepath in pathex.get_file_paths(saved_models_path):
                        filepath_name = filepath.name
                        if filepath_name.endswith(f'{model_class_name}_data.dat'):
                            saved_models_names += [ (filepath_name.split('_')[0], os.path.getmtime(filepath)) ]

                    # 根据修改时间对模型进行排序
                    saved_models_names = sorted(saved_models_names, key=operator.itemgetter(1), reverse=True )
                    saved_models_names = [ x[0] for x in saved_models_names ]


                    if len(saved_models_names) != 0:
                        if silent_start:
                            self.model_name = saved_models_names[0]
                            io.log_info(f'快捷启动：选择模型“{self.model_name}"')
                        else:
                            io.log_info ("选择一个模型, 或者输入一个名称去新建模型.")
                            io.log_info ("[r] : 重命名")
                            io.log_info ("[d] : 删除")
                            io.log_info ("")
                            for i, model_name in enumerate(saved_models_names):
                                s = f"[{i}] : {model_name} "
                                if i == 0:
                                    s += "- 上次执行"
                                io.log_info (s)

                            inp = io.input_str(f"", "0", show_default_value=False )
                            model_idx = -1
                            try:
                                model_idx = np.clip ( int(inp), 0, len(saved_models_names)-1 )
                            except:
                                pass

                            if model_idx == -1:
                                if len(inp) == 1:
                                    is_rename = inp[0] == 'r'
                                    is_delete = inp[0] == 'd'

                                    if is_rename or is_delete:
                                        if len(saved_models_names) != 0:

                                            if is_rename:
                                                name = io.input_str(f"输入你想要重命名的模型名称")
                                            elif is_delete:
                                                name = io.input_str(f"输入你想要删除的模型名称")

                                            if name in saved_models_names:

                                                if is_rename:
                                                    new_model_name = io.input_str(f"输入一个新的模型名称")

                                                for filepath in pathex.get_paths(saved_models_path):
                                                    filepath_name = filepath.name

                                                    model_filename, remain_filename = filepath_name.split('_', 1)
                                                    if model_filename == name:

                                                        if is_rename:
                                                            new_filepath = filepath.parent / ( new_model_name + '_' + remain_filename )
                                                            filepath.rename (new_filepath)
                                                        elif is_delete:
                                                            filepath.unlink()
                                        continue

                                self.model_name = inp
                            else:
                                self.model_name = saved_models_names[model_idx]

                    else:
                        self.model_name = io.input_str(f"没有发现模型，输入一个名字新建模型", "new")
                        self.model_name = self.model_name.replace('_', ' ')
                    break


            self.model_name = self.model_name + '_' + self.model_class_name
        else:
            self.model_name = force_model_class_name


        
        self.iter = 0
        self.options = {}
        self.options_show_override = {}
        self.loss_history = []
        self.sample_for_preview = None
        self.choosed_gpu_indexes = None

        model_data = {}
        self.model_data_path = Path( self.get_strpath_storage_for_file('data.dat') )
        if self.model_data_path.exists():

            model_data = pickle.loads ( self.model_data_path.read_bytes() )
            self.iter = model_data.get("iter", 0)
            try:
                self.author_name = model_data.get("author_name", "神农汉化")
            except KeyError:
                # 如果取值失败，忽略错误并将属性设置为 "神农汉化"
                print(f"读取作者名失败，模型是从旧版DFL升级")
                self.author_name = "神农汉化"
                
            self.iter = model_data.get('iter',0)
            if self.iter != 0:
                self.options = model_data['options']
                self.loss_history = model_data.get('loss_history', [])
                self.sample_for_preview = model_data.get('sample_for_preview', None)
                self.choosed_gpu_indexes = model_data.get('choosed_gpu_indexes', None)

        if self.is_first_run():
            io.log_info ("\n新模型创建后的首次训练开始.")
            
        if force_gpu_idxs is not None:
            gpu_idxs = force_gpu_idxs
            self.options['gpu_idxs'] = force_gpu_idxs
        elif silent_start:
            try:
                gpu_idxs=self.options['gpu_idxs']
            except:
                gpu_idxs=self.options['gpu_idxs']=nn.ask_choose_device_idxs(suggest_best_multi_gpu=True)
        else:
            gpu_idxs=self.options['gpu_idxs']=nn.ask_choose_device_idxs(suggest_best_multi_gpu=True)
            
        self.device_config = nn.DeviceConfig.GPUIndexes(gpu_idxs) if not cpu_only else nn.DeviceConfig.CPU()
        nn.initialize(self.device_config)  # 初始化神经网络，使用设备配置

        ####
        self.default_options_path = saved_models_path / f'{self.model_class_name}_default_options.dat'
        self.default_options = {}
        if self.default_options_path.exists():
            try:
                self.default_options = pickle.loads ( self.default_options_path.read_bytes() )
            except:
                pass

        self.choose_preview_history = False
        self.batch_size = self.load_or_def_option('batch_size', 1)
        #####

        io.input_skip_pending()
        self.on_initialize_options()

        if self.is_first_run():
            # save as default options only for first run model initialize
            self.default_options_path.write_bytes( pickle.dumps (self.options) )

        self.autobackup_hour = self.options.get('autobackup_hour', 0)
        self.write_preview_history = self.options.get('write_preview_history', False)
        self.target_iter = self.options.get('target_iter',0)
        self.random_flip = self.options.get('random_flip',True)
        self.random_src_flip = self.options.get('random_src_flip', False)
        self.random_dst_flip = self.options.get('random_dst_flip', True)
        self.retraining_samples = self.options.get('retraining_samples', False)
        
        self.on_initialize()
        self.options['batch_size'] = self.batch_size

        self.preview_history_writer = None
        if self.is_training:
            self.preview_history_path = self.saved_models_path / ( f'{self.get_model_name()}_history' )
            self.autobackups_path     = self.saved_models_path / ( f'{self.get_model_name()}_autobackups' )

            if self.write_preview_history or io.is_colab():
                if not self.preview_history_path.exists():
                    self.preview_history_path.mkdir(exist_ok=True)
                else:
                    if self.iter == 0:
                        for filename in pathex.get_image_paths(self.preview_history_path):
                            Path(filename).unlink()

            if self.generator_list is None:
                raise ValueError( '你没有设置训练数据生成器()')
            else:
                for i, generator in enumerate(self.generator_list):
                    if not isinstance(generator, SampleGeneratorBase):
                        raise ValueError('训练数据生成器不是样本生成器库的子类')

            self.update_sample_for_preview(choose_preview_history=self.choose_preview_history)

            if self.autobackup_hour != 0:
                self.autobackup_start_time = time.time()

                if not self.autobackups_path.exists():
                    self.autobackups_path.mkdir(exist_ok=True)
        if self.ask_override:
            try:
                io.log_info( self.get_summary_text() )
            except KeyError:
                print(f"参数尚未填写完整！将无法保存！")

    def update_sample_for_preview(self, choose_preview_history=False, force_new=False):
        if self.sample_for_preview is None or choose_preview_history or force_new:
            if choose_preview_history and io.is_support_windows():
                wnd_name = "[p] - 下一张. [space] - 切换预览类型. [enter] - 确认\n ."
                io.log_info (f"为预览历史选择图像. {wnd_name}")
                io.named_window(wnd_name)
                io.capture_keys(wnd_name)
                choosed = False
                preview_id_counter = 0
                while not choosed:
                    self.sample_for_preview = self.generate_next_samples()
                    previews = self.get_history_previews()

                    io.show_image( wnd_name, ( previews[preview_id_counter % len(previews) ][1] *255).astype(np.uint8) )

                    while True:
                        key_events = io.get_key_events(wnd_name)
                        key, chr_key, ctrl_pressed, alt_pressed, shift_pressed = key_events[-1] if len(key_events) > 0 else (0,0,False,False,False)
                        if key == ord('\n') or key == ord('\r'):
                            choosed = True
                            break
                        elif key == ord(' '):
                            preview_id_counter += 1
                            break
                        elif key == ord('p'):
                            break

                        try:
                            io.process_messages(0.1)
                        except KeyboardInterrupt:
                            choosed = True

                io.destroy_window(wnd_name)
            else:
                self.sample_for_preview = self.generate_next_samples()

        try:
            self.get_history_previews()
        except:
            self.sample_for_preview = self.generate_next_samples()

        self.last_sample = self.sample_for_preview

    def load_or_def_option(self, name, def_value):
        # 优先返回模型选项
        options_val = self.options.get(name, None)
        if options_val is not None:
            return options_val
        # 否则返回保存的def选项
        def_opt_val = self.default_options.get(name, None)
        if def_opt_val is not None:
            return def_opt_val
        # 否则返回 传入参数
        return def_value


    def get_model_type(self):
        return self.model
    def ask_override(self):
        try:
            io.log_info( self.get_summary_text() )
        except KeyError:
            print(f"模型首次在神农运行,强制询问参数")
            return True
 
        
        return self.is_training and self.iter != 0 and io.input_in_time ("五秒内按下Enter键设置模型参数...", 5 if io.is_colab() else 5 )

    def ask_author_name(self):

        # 询问用户输入名
        self.author_name = io.input_str(
            "模型作者 Author name",
            "神农汉化",
            help_message="显示的作者署名",
        )
    '''    
    def ask_gpu_idxs(self, default_value=0):
        default_autobackup_hour = self.options['gpu_idxs'] = self.load_or_def_option('gpu_idxs', default_value)
        self.options['gpu_idxs'] = io.input_int(f"默认显卡设备", 0, add_info="例如：0,1", help_message="一个或多个 GPU 索引（用逗号分隔）")
    '''   
    def ask_autobackup_hour(self, default_value=0):
        default_autobackup_hour = self.options['autobackup_hour'] = self.load_or_def_option('autobackup_hour', default_value)
        self.options['autobackup_hour'] = io.input_int(f"几个小时备份一次", default_autobackup_hour, add_info="0..24", help_message="自动备份模型文件，每 N 小时预览一次。 最新备份位于 model/<>_autobackups/01")

    def ask_write_preview_history(self, default_value=False):
        default_write_preview_history = self.load_or_def_option('write_preview_history', default_value)
        self.options['write_preview_history'] = io.input_bool(f"保存预览历史记录", default_write_preview_history, help_message="预览历史将写入 <Model Name>history 文件夹.")

        if self.options['write_preview_history']:
            if io.is_support_windows():
                self.choose_preview_history = io.input_bool("为预览历史选择图像", False)
            elif io.is_colab():
                self.choose_preview_history = io.input_bool("随机选择新图像作为预览历史", False, help_message="如果您在不同名人上重复使用同一模型，则预览图像历史记录将保留旧面孔。 选择否，除非你将src / dst更改为新的")

    def ask_target_iter(self, default_value=0):
        default_target_iter = self.load_or_def_option('target_iter', default_value)
        self.options['target_iter'] = max(0, io.input_int("目标迭代次数", default_target_iter))

    def ask_random_flip(self):
        default_random_flip = self.load_or_def_option('random_flip', True)
        self.options['random_flip'] = io.input_bool("人脸随机翻转", default_random_flip, help_message="没有此选项，预测的脸部看起来会更自然，但是src faceset应该像dst faceset一样覆盖所有脸部方向.")
    
    def ask_random_src_flip(self):
        default_random_src_flip = self.load_or_def_option('random_src_flip', False)
        self.options['random_src_flip'] = io.input_bool("随机翻转SRC人脸", default_random_src_flip, help_message="随机水平翻转 SRC faceset。 覆盖更多角度，但脸部可能看起来不那么自然.")

    def ask_random_dst_flip(self):
        default_random_dst_flip = self.load_or_def_option('random_dst_flip', True)
        self.options['random_dst_flip'] = io.input_bool("随机翻转DST人脸", default_random_dst_flip, help_message="随机水平翻转 DST 面集。 如果未启用 src 随机翻转，则使 src->dst 的泛化更好.")

    def ask_batch_size(self, suggest_batch_size=None, range=None):
        default_batch_size = self.load_or_def_option('batch_size', suggest_batch_size or self.batch_size)

        batch_size = max(0, io.input_int("批量大小", default_batch_size, valid_range=range, help_message="更大的批量大小更适合 NN 的泛化，但会导致 OOM 错误。 手动为您的显卡调整此值."))

        if range is not None:
            batch_size = np.clip(batch_size, range[0], range[1])

        self.options['batch_size'] = self.batch_size = batch_size
        
    def ask_retraining_samples(self, default_value=False):
        default_retraining_samples = self.load_or_def_option('retraining_samples', default_value)
        self.options['retraining_samples'] = io.input_bool("ME版选项 周期性训练 高LOSS脸图样本 （retraining_samples）", default_retraining_samples, help_message="打开这个选项 将会周期性训练 高LOSS脸图样本")


    #overridable
    def on_initialize_options(self):
        pass

    #overridable
    def on_initialize(self):
        '''
        initialize your models

        store and retrieve your model options in self.options['']

        check example
        '''
        pass

    #overridable
    def onSave(self):
        #save your models here
        pass

    #overridable
    def onTrainOneIter(self, sample, generator_list):
        #train your models here

        #return array of losses
        return ( ('loss_src', 0), ('loss_dst', 0) )

    #overridable
    def onGetPreview(self, sample, for_history=False):
        #you can return multiple previews
        #return [ ('preview_name',preview_rgb), ... ]
        return []

    #overridable if you want model name differs from folder name
    def get_model_name(self):
        return self.model_name

    #overridable , return [ [model, filename],... ]  list
    def get_model_filename_list(self):
        return []

    #overridable
    def get_MergerConfig(self):
        #return predictor_func, predictor_input_shape, MergerConfig() for the model
        raise NotImplementedError

    def get_pretraining_data_path(self):
        return self.pretraining_data_path

    def get_target_iter(self):
        return self.target_iter

    def is_reached_iter_goal(self):
        return self.target_iter != 0 and self.iter >= self.target_iter

    def get_previews(self):
        return self.onGetPreview ( self.last_sample )

    def get_history_previews(self):
        return self.onGetPreview (self.sample_for_preview, for_history=True)

    def get_preview_history_writer(self):
        if self.preview_history_writer is None:
            self.preview_history_writer = PreviewHistoryWriter()
        return self.preview_history_writer

    def save(self):
        Path( self.get_summary_path() ).write_text( self.get_summary_text(), encoding="utf-8")

        self.onSave()

        model_data = {
            'iter': self.iter,
            "author_name": self.author_name,
            'options': self.options,
            'loss_history': self.loss_history,
            'sample_for_preview' : self.sample_for_preview,
            'choosed_gpu_indexes' : self.choosed_gpu_indexes,
        }
        pathex.write_bytes_safe (self.model_data_path, pickle.dumps(model_data) )

        if self.autobackup_hour != 0:
            diff_hour = int ( (time.time() - self.autobackup_start_time) // 3600 )

            if diff_hour > 0 and diff_hour % self.autobackup_hour == 0:
                self.autobackup_start_time += self.autobackup_hour*3600
                self.create_backup()

    def create_backup(self):
        io.log_info ("创建备份中...", end='\r')

        if not self.autobackups_path.exists():
            self.autobackups_path.mkdir(exist_ok=True)

        bckp_filename_list = [ self.get_strpath_storage_for_file(filename) for _, filename in self.get_model_filename_list() ]
        bckp_filename_list += [ str(self.get_summary_path()), str(self.model_data_path) ]

        for i in range(24,0,-1):
            idx_str = '%.2d' % i
            next_idx_str = '%.2d' % (i+1)

            idx_backup_path = self.autobackups_path / idx_str
            next_idx_packup_path = self.autobackups_path / next_idx_str

            if idx_backup_path.exists():
                if i == 24:
                    pathex.delete_all_files(idx_backup_path)
                else:
                    next_idx_packup_path.mkdir(exist_ok=True)
                    pathex.move_all_files (idx_backup_path, next_idx_packup_path)

            if i == 1:
                idx_backup_path.mkdir(exist_ok=True)
                for filename in bckp_filename_list:
                    shutil.copy ( str(filename), str(idx_backup_path / Path(filename).name) )

                previews = self.get_previews()
                plist = []
                for i in range(len(previews)):
                    name, bgr = previews[i]
                    plist += [ (bgr, idx_backup_path / ( ('preview_%s.jpg') % (name))  )  ]

                if len(plist) != 0:
                    self.get_preview_history_writer().post(plist, self.loss_history, self.iter)

    def debug_one_iter(self):
        images = []
        for generator in self.generator_list:
            for i,batch in enumerate(next(generator)):
                if len(batch.shape) == 4:
                    images.append( batch[0] )

        return imagelib.equalize_and_stack_square (images)

    def generate_next_samples(self):
        sample = []
        for generator in self.generator_list:
            if generator.is_initialized():
                sample.append ( generator.generate_next() )
            else:
                sample.append ( [] )
        self.last_sample = sample
        return sample

    #overridable
    def should_save_preview_history(self):
        return (not io.is_colab() and self.iter % 10 == 0) or (io.is_colab() and self.iter % 100 == 0)

    def train_one_iter(self):

        iter_time = time.time()
        losses = self.onTrainOneIter()
        iter_time = time.time() - iter_time

        self.loss_history.append ( [float(loss[1]) for loss in losses] )

        if self.should_save_preview_history():
            plist = []

            if io.is_colab():
                previews = self.get_previews()
                for i in range(len(previews)):
                    name, bgr = previews[i]
                    plist += [ (bgr, self.get_strpath_storage_for_file('preview_%s.jpg' % (name) ) ) ]

            if self.write_preview_history:
                previews = self.get_history_previews()
                for i in range(len(previews)):
                    name, bgr = previews[i]
                    path = self.preview_history_path / name
                    plist += [ ( bgr, str ( path / ( f'{self.iter:07d}.jpg') ) ) ]
                    if not io.is_colab():
                        plist += [ ( bgr, str ( path / ( '_last.jpg' ) )) ]

            if len(plist) != 0:
                self.get_preview_history_writer().post(plist, self.loss_history, self.iter)

        self.iter += 1

        return self.iter, iter_time

    def pass_one_iter(self):
        self.generate_next_samples()

    def finalize(self):
        nn.close_session()

    def is_first_run(self):
        return self.iter == 0

    def is_debug(self):
        return self.debug

    def set_batch_size(self, batch_size):
        self.batch_size = batch_size

    def get_batch_size(self):
        return self.batch_size

    def get_iter(self):
        return self.iter

    def set_iter(self, iter):
        self.iter = iter
        self.loss_history = self.loss_history[:iter]

    def get_loss_history(self):
        return self.loss_history

    def set_training_data_generators (self, generator_list):
        self.generator_list = generator_list

    def get_training_data_generators (self):
        return self.generator_list

    def get_model_root_path(self):
        return self.saved_models_path

    def get_strpath_storage_for_file(self, filename):
        return str( self.saved_models_path / ( self.get_model_name() + '_' + filename) )

    def get_summary_path(self):
        return self.get_strpath_storage_for_file('summary.txt')

    def get_summary_text(self):
        visible_options = self.options.copy()
        visible_options.update(self.options_show_override)
        self.options["retraining_samples"]=False
        #把参数值汉化
        def str2cn(option):
            try:
                if str(option) == "False" or str(option) == "n":
                    return "关"
                elif str(option) == "True" or str(option) == "y":
                    return "开"
                else:
                    return str(option)
            except:
                return "未定义"

        # 创建一个空表格对象，并指定列名
        if self.model_class_name == "XSeg":
            xs_res = self.options.get("resolution", 256)
            table = PrettyTable(
                ["分辨率", "模型作者", "批处理大小", "手标素材量"]
            )
            table.add_row(
                [
                    str(xs_res),
                    str2cn(self.author_name),
                    str2cn(self.batch_size),
                    str2cn(self.options["seg_sample_count"]),
                ]
            )    
            # 打印表格
            summary_text = table.get_string()
            return summary_text
            
        elif self.model_class_name =="SAEHD":

            table = PrettyTable(
                ["模型摘要", "增强选项", "开关", "参数设置", "数值", "本机配置"]
            )

            # 添加数据行
            table.add_row(
                [
                    "预训练模式:" +  str2cn(self.options["pretrain"]),
                    "重新训练高损失样本",
                    str2cn(self.options["retraining_samples"]),
                    "批处理大小",
                    str2cn(self.batch_size),
                    "AdaBelief优化器: "+str2cn(self.options["adabelief"]),
                ]
            )
            table.add_row(
                [
                    "模型名称: " + self.get_model_name(),
                    "随机翻转SRC",
                    str2cn(self.options["random_src_flip"]),
                    "",
                    "",
                    "优化器放到GPU上: "+str2cn(self.options["models_opt_on_gpu"]),
                ]
            )
            table.add_row(
                [
                    "模型作者: " + self.author_name,
                    "随机翻转DST",
                    str2cn(self.options["random_dst_flip"]),
                    "真脸(src)强度",
                    str2cn(self.options["true_face_power"]),
                    "",
                ]
            )
            table.add_row(
                [
                    "迭代数: " + str2cn(self.get_iter()),
                    "遮罩训练",
                    str2cn(self.options["masked_training"]),
                    "人脸(dst)强度",
                    str2cn(self.options["face_style_power"]),
                    "目标迭代次数: " + str2cn(self.options["target_iter"]),
                ]
            )       
            table.add_row(
                [
                    "模型架构: " + str2cn(self.options["archi"]),
                    "眼嘴优先",
                    str2cn(self.options["eyes_mouth_prio"]),
                    "背景(dst)强度",
                    str2cn(self.options["bg_style_power"]),
                    "",
                ]
            )

            table.add_row(
                [
                    "分辨率:" + str2cn(self.options["resolution"]),
                    "侧脸优化",
                    str2cn(self.options["uniform_yaw"]),
                    "色彩转换模式",
                    str2cn(self.options["ct_mode"]),
                    "启用梯度裁剪: "+str2cn(self.options["clipgrad"]),
                ]
            )    
            table.add_row(
                [
                    "自动编码器(ae_dims): " + str2cn(self.options["ae_dims"]),
                    "遮罩边缘模糊",
                    str2cn(self.options["blur_out_mask"]),
                    "",
                    "",
                    "",
                ]
            )
            table.add_row(
                [
                    "编码器(e_dims): " + str2cn(self.options["e_dims"]),
                    "使用学习率下降",
                    str2cn(self.options["lr_dropout"]),
                    "gan_power",
                    str2cn(self.options["gan_power"]),
                    "记录预览图演变史: " + str2cn(self.options["write_preview_history"]),
                ]
            )
            table.add_row(
                [
                    "解码器(d_dims): " +  str2cn(self.options["d_dims"]),
                    "随机扭曲",
                    str2cn(self.options["random_warp"]),
                    "gan_patch_size",
                    str2cn(self.options["gan_patch_size"]),
                    "",
                ]
            )
            table.add_row(
                [
                    "解码器遮罩(d_mask): " +  str2cn(self.options["d_mask_dims"]),
                    "随机颜色(hsv)",
                    str2cn(self.options["random_hsv_power"]),
                    "gan_dims",
                    str2cn(self.options["gan_dims"]),
                    "自动备份间隔: " + str2cn(self.options["autobackup_hour"]) + " 小时",
                ]
            )      


            # 设置对齐方式（可选）["模型摘要", "增强选项", "开关", "参数设置", "数值", "本机配置"]
            table.align["模型摘要"] = "l"  # 左对齐
            table.align["增强选项"] = "r"  # 居中对齐
            table.align["开关"] = "l"  # 居中对齐
            table.align["参数设置"] = "r"  # 居中对齐
            table.align["数值"] = "l"  # 居中对齐
            table.align["本机配置"] = "r"  # 居中对齐
            
            # 打印表格
            summary_text = table.get_string()
            return summary_text
        
        elif self.model_class_name =="Quick224":    
            summary_text = "神农Quick224对显卡无要求，不必纠结参数和细节，仅玩玩！"
            return summary_text

    @staticmethod
    def get_loss_history_preview(loss_history, iter, w, c):
        # 将损失历史数据转换为NumPy数组，并复制一份以防止修改原始数据
        loss_history = np.array(loss_history.copy())
    
        # 设定图像高度
        lh_height = 120
        # 创建一个指定高度、宽度和通道数的图像数组，初始值为0.1
        lh_img = np.ones((lh_height, w, c)) * 0.1

        # 检查损失历史数据是否为空
        if len(loss_history) != 0:
            # 损失函数数量
            loss_count = len(loss_history[0])
            # 损失历史数据长度
            lh_len = len(loss_history)

            # 计算每列损失数据量
            l_per_col = lh_len / w

            # 计算每列的最大损失值
            plist_max = [
                [
                    max(0.0, loss_history[int(col * l_per_col)][p],
                        *[loss_history[i_ab][p]
                          for i_ab in range(int(col * l_per_col), int((col + 1) * l_per_col))
                          ])
                    for p in range(loss_count)
                ]
                for col in range(w)
            ]

            # 计算每列的最小损失值
            plist_min = [
                [
                    min(plist_max[col][p], loss_history[int(col * l_per_col)][p],
                        *[loss_history[i_ab][p]
                          for i_ab in range(int(col * l_per_col), int((col + 1) * l_per_col))
                          ])
                    for p in range(loss_count)
                ]
                for col in range(w)
            ]

            # 计算损失值的绝对最大值
            plist_abs_max = np.mean(loss_history[len(loss_history) // 5:]) * 2

            # 遍历每一列
            for col in range(0, w):
                # 遍历每一个损失函数
                for p in range(0, loss_count):
                    # 设置数据点的颜色，根据HSV颜色空间生成
                    point_color = [1.0] * 3
                    # loss_count=2 , p=0 or 1
                    #point_color[0:3] = colorsys.hsv_to_rgb(p * (1.0 / loss_count), 1.0, 0.8)
                    point_color_src=(0.0, 0.8, 0.9)
                    point_color_dst=(0.8, 0.3, 0.0)
                    point_color_mix=(0.1, 0.8, 0.0)
                    # 根据实验，应该是BGR的顺序
                    if p==0:
                        point_color=point_color_dst
                    if p==1:
                        point_color=point_color_src
                    # 计算数据点在图像中的位置（最大值和最小值）
                    ph_max = int((plist_max[col][p] / plist_abs_max) * (lh_height - 1))
                    ph_max = np.clip(ph_max, 0, lh_height - 1)
                    ph_min = int((plist_min[col][p] / plist_abs_max) * (lh_height - 1))
                    ph_min = np.clip(ph_min, 0, lh_height-1)  # 将最小值限制在图像高度范围内

                    # 遍历从最小值到最大值的范围
                    for ph in range(ph_min, ph_max+1):
                        # 在图像数组中根据计算得到的位置和颜色添加标记点
                        # 注意：由于数组的原点通常位于左上角，所以需要使用(lh_height-ph-1)来将y坐标转换为数组索引
                        if p==0:
                            lh_img[(lh_height-ph-1), col] = point_color
                        if p==1:
                            current_point_color = lh_img[(lh_height-ph-1), col]
                            # 叠加新的颜色到当前颜色
                            #final_color = [min(1.0, current_point_color[i] + point_color_src[i]) for i in range(3)]
                            #lh_img[(lh_height-ph-1), col] = final_color
                            if (current_point_color == point_color_dst).all():
                                lh_img[(lh_height-ph-1), col] = point_color_mix
                            else:
                                lh_img[(lh_height-ph-1), col] = point_color_src
                                

        lh_lines = 8
        # 计算每行的高度
        lh_line_height = (lh_height-1)/lh_lines
        
        # 设置线条颜色和透明度
        line_color = (0.2, 0.2, 0.2)  # 灰色
        
        for i in range(0,lh_lines+1):
            # 获取当前分割线所在行的索引
            line_index = int(i * lh_line_height)
            # 将当前行的像素值设置为线条颜色和透明度
            lh_img[line_index, :] = line_color
            # 原灰色 lh_img[ int(i*lh_line_height), : ] = (0.8,)*c

        # 计算最后一行文字的高度位置
        last_line_t = int((lh_lines-1)*lh_line_height)
        last_line_b = int(lh_lines*lh_line_height)

        lh_text = '迭代数: %d  iter' % (iter) if iter != 0 else ''

        lh_img[last_line_t:last_line_b, 0:w] += imagelib.get_text_image (  (last_line_b-last_line_t,w,c), lh_text, color=[0.8]*c )
        return lh_img

class PreviewHistoryWriter():
    def __init__(self):
        self.sq = multiprocessing.Queue()
        self.p = multiprocessing.Process(target=self.process, args=( self.sq, ))
        self.p.daemon = True
        self.p.start()

    def process(self, sq):
        while True:
            while not sq.empty():
                plist, loss_history, iter = sq.get()

                preview_lh_cache = {}
                for preview, filepath in plist:
                    filepath = Path(filepath)
                    i = (preview.shape[1], preview.shape[2])

                    preview_lh = preview_lh_cache.get(i, None)
                    if preview_lh is None:
                        preview_lh = ModelBase.get_loss_history_preview(loss_history, iter, preview.shape[1], preview.shape[2])
                        preview_lh_cache[i] = preview_lh

                    img = (np.concatenate ( [preview_lh, preview], axis=0 ) * 255).astype(np.uint8)

                    filepath.parent.mkdir(parents=True, exist_ok=True)
                    cv2_imwrite (filepath, img )

            time.sleep(0.01)

    def post(self, plist, loss_history, iter):
        self.sq.put ( (plist, loss_history, iter) )

    # disable pickling
    def __getstate__(self):
        return dict()
    def __setstate__(self, d):
        self.__dict__.update(d)
