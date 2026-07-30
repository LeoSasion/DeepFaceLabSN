import os
import sys
import traceback
import queue
import threading
import time
import json
import numpy as np
import itertools
from pathlib import Path
from core import pathex
from core import imagelib
import cv2
import models
from core.interact import interact as io
import win32gui



class GlobalMeanLoss:
    def __init__(self):
        self.src = "未记录"
        self.dst = "未记录"

global global_mean_loss
global_mean_loss = GlobalMeanLoss()


class WebTrainerBridge:
    """Optional file bridge used by the loopback Web manager.

    The bridge is inactive unless the launcher provides both paths. Keeping it
    in the UI thread means all operations still pass through Trainer's original
    s2c queue and model-save code.
    """

    allowed_operations = {'save', 'backup', 'preview', 'close'}

    def __init__(self):
        control_path = os.environ.get('DFL_WEB_CONTROL_FILE', '').strip()
        preview_path = os.environ.get('DFL_WEB_PREVIEW_FILE', '').strip()
        self.control_path = Path(control_path) if control_path else None
        self.preview_path = Path(preview_path) if preview_path else None
        self.control_offset = 0

    def poll_operations(self):
        if self.control_path is None or not self.control_path.exists():
            return []

        operations = []
        try:
            with self.control_path.open('r', encoding='utf-8') as control_file:
                control_file.seek(self.control_offset)
                for line in control_file:
                    try:
                        operation = json.loads(line).get('operation', '')
                    except Exception:
                        continue
                    if operation in self.allowed_operations:
                        operations.append(operation)
                self.control_offset = control_file.tell()
        except Exception:
            return []
        return operations

    def write_preview(self, previews):
        if self.preview_path is None or not previews:
            return
        try:
            self.preview_path.parent.mkdir(parents=True, exist_ok=True)
            preview_rgb = np.clip(previews[0][1], 0, 1)
            preview_bgr = (preview_rgb[:, :, ::-1] * 255).astype(np.uint8)
            success, encoded = cv2.imencode('.png', preview_bgr)
            if not success:
                return
            temporary_path = self.preview_path.with_suffix(
                self.preview_path.suffix + '.tmp'
            )
            encoded.tofile(str(temporary_path))
            os.replace(str(temporary_path), str(self.preview_path))
        except Exception:
            pass


def trainerThread (s2c, c2s, e,
                    model_class_name = None,
                    saved_models_path = None,
                    training_data_src_path = None,
                    training_data_dst_path = None,
                    pretraining_data_path = None,
                    pretrained_model_path = None,
                    no_preview=False,
                    force_model_name=None,
                    force_gpu_idxs=None,
                    cpu_only=None,
                    silent_start=False,
                    execute_programs = None,
                    debug=False,
                    **kwargs):

    while True:
        try:
            start_time = time.time()

            save_interval_min = 25

            if not training_data_src_path.exists():
                training_data_src_path.mkdir(exist_ok=True, parents=True)

            if not training_data_dst_path.exists():
                training_data_dst_path.mkdir(exist_ok=True, parents=True)

            if not saved_models_path.exists():
                saved_models_path.mkdir(exist_ok=True, parents=True)

            model = models.import_model(model_class_name)(
                        is_training=True,
                        saved_models_path=saved_models_path,
                        training_data_src_path=training_data_src_path,
                        training_data_dst_path=training_data_dst_path,
                        pretraining_data_path=pretraining_data_path,
                        pretrained_model_path=pretrained_model_path,
                        no_preview=no_preview,
                        force_model_name=force_model_name,
                        force_gpu_idxs=force_gpu_idxs,
                        cpu_only=cpu_only,
                        silent_start=silent_start,
                        debug=debug)

            is_reached_goal = model.is_reached_iter_goal()

            shared_state = { 'after_save' : False }
            loss_string = ""
            save_iter =  model.get_iter()
            def model_save():
                if not debug and not is_reached_goal:
                    io.log_info ("正在保存...", end='\r')
                    model.save()
                    shared_state['after_save'] = True

            def model_backup():
                if not debug and not is_reached_goal:
                    model.create_backup()

            def send_preview():
                if not debug:
                    previews = model.get_previews()
                    c2s.put ( {'op':'show', 'previews': previews, 'iter':model.get_iter(), 'loss_history': model.get_loss_history().copy() } )
                else:
                    previews = [( 'debug, press update for new', model.debug_one_iter())]
                    c2s.put ( {'op':'show', 'previews': previews} )
                e.set() #Set the GUI Thread as Ready

            if model.get_target_iter() != 0:
                if is_reached_goal:
                    io.log_info('模型已经训练到目标迭代')
                else:
                    io.log_info('开始训练! 目标迭代:%d 按“Enter”键停止训练并保存模型' % ( model.get_target_iter()  ) )
            else:
                io.log_info('')
                io.log_info('启动中.....')
                io.log_info('按 Enter 停止训练并保存进度')
                io.log_info('按 Space 可以切换视图')
                io.log_info('按 P 可以刷新预览图')
                io.log_info('按 S 可以保存训练进度')
                io.log_info('')
                io.log_info('[保存时间][迭代次数][单次迭代][SRC损失][DST损失]')
            last_save_time = time.time()

            # 更新 execute_programs 列表中每个程序的执行时间
            execute_programs = [[x[0], x[1], time.time()] for x in execute_programs]

            # 从0开始，步长为1的无限循环
            for i in itertools.count(0, 1):
                if not debug:  # 检查调试模式是否已禁用
                    cur_time = time.time()  # 获取当前时间

                    # 遍历 execute_programs 列表中的每个程序
                    for x in execute_programs:
                        prog_time, prog, last_time = x  # 解包列表中的程序详情
                        exec_prog = False  # 初始化一个标志，用于确定是否应执行程序

                        # 根据指定的时间条件检查是否是执行程序的时间
                        if prog_time > 0 and (cur_time - start_time) >= prog_time:
                            x[0] = 0  # 将程序的时间重置为0
                            exec_prog = True  # 设置执行程序的标志
                        elif prog_time < 0 and (cur_time - last_time) >= -prog_time:
                            x[2] = cur_time  # 更新上次执行时间为当前时间
                            exec_prog = True  # 设置执行程序的标志

                        # 如果标志已设置，则执行程序
                        if exec_prog:
                            try:
                                exec(prog)  # 执行程序
                            except Exception as e:
                                print("无法执行程序：%s" % (prog))  # 如果执行失败，则打印错误消息


                    if not is_reached_goal:

                        if model.get_iter() == 0:
                            io.log_info("")
                            io.log_info("试着做第一次迭代。如果出现错误，请减少模型参数")
                            io.log_info("")


                        iter, iter_time = model.train_one_iter()
                        # 获取模型的损失历史记录
                        loss_history = model.get_loss_history()

                        # 获取当前时间并格式化
                        time_str = time.strftime("[%H:%M:%S]")

                        # 如果迭代时间超过10秒，则将时间格式化为浮点数，保留四位小数
                        if iter_time >= 10:
                            loss_string = "{0}[#{1:06d}][{2:.5s}s]".format(time_str, iter, '{:0.4f}'.format(iter_time))
                        # 否则，将时间格式化为整数（毫秒）
                        else:
                            loss_string = "{0}[#{1:06d}][{2:04d}ms]".format(time_str, iter, int(iter_time*1000))

                        # 如果在保存后执行
                        if shared_state['after_save']:
                            shared_state['after_save'] = False

                            # 计算从上次保存迭代到当前迭代的平均损失值
                            mean_loss = np.mean(loss_history[save_iter:iter], axis=0)

                            global_mean_loss.src="[{:.4f}]".format(mean_loss[0])
                            global_mean_loss.dst="[{:.4f}]".format(mean_loss[1])

                            # 将平均损失值添加到损失字符串中
                            for loss_value in mean_loss:
                                loss_string += "[%.4f]" % (loss_value)

                            # 记录损失字符串到日志中
                            io.log_info(loss_string)

                            # 更新保存迭代的值
                            save_iter = iter
                        else:
                            # 否则，将最新的损失值添加到损失字符串中
                            for loss_value in loss_history[-1]:
                                loss_string += "[%.4f]" % (loss_value)

                            # 如果在Google Colab环境中，则使用'\r'结束字符串，以实现覆盖打印
                            if io.is_colab():
                                io.log_info('\r' + loss_string, end='')
                            # 否则，正常打印损失字符串
                            else:
                                io.log_info(loss_string, end='\r')


                        if model.get_iter() == 1:
                            model_save()

                        if model.get_target_iter() != 0 and model.is_reached_iter_goal():
                            io.log_info ('达到目标迭代')
                            model_save()
                            is_reached_goal = True

                need_save = False
                while time.time() - last_save_time >= save_interval_min*60:
                    last_save_time += save_interval_min*60
                    need_save = True

                if not is_reached_goal and need_save:
                    model_save()
                    send_preview()

                if i==0:
                    if is_reached_goal:
                        model.pass_one_iter()
                    send_preview()

                if debug:
                    time.sleep(0.005)

                while not s2c.empty():
                    input = s2c.get()
                    op = input['op']
                    if op == 'save':
                        model_save()
                    elif op == 'backup':
                        model_backup()
                    elif op == 'preview':
                        if is_reached_goal:
                            model.pass_one_iter()
                        send_preview()
                    elif op == 'close':
                        model_save()
                        i = -1
                        break

                if i == -1:
                    break



            model.finalize()

        except Exception as e:
            print ('Error: %s' % (str(e)))
            traceback.print_exc()
        break
    c2s.put ( {'op':'close'} )


def cv_set_titile(oldTitle,newTitle='神农',oneRun=False):
    """
    设置窗口标题
    :param oldTitle: 旧标题
    :param newTitle: 新标题
    :param oneRun: 是否只运行一次
    :return:
    """
    if oneRun == False:
        # 根据窗口名称查找其句柄 然后使用函数修改其标题
        # 尽量选择一个不常见的英文名 防止误该已有#的窗口标题 初始化时通常取无意义的名字  比如这里取‘aa’
        handle = win32gui.FindWindow(0, oldTitle)
        win32gui.SetWindowText(handle, newTitle)
        oneRun= True
    return oneRun

def main(**kwargs):

    no_preview = kwargs.get('no_preview', False)
    web_bridge = WebTrainerBridge()

    s2c = queue.Queue()
    c2s = queue.Queue()

    e = threading.Event()
    thread = threading.Thread(target=trainerThread, args=(s2c, c2s, e), kwargs=kwargs )
    thread.start()

    e.wait() #Wait for inital load to occur.


    if no_preview:
        while True:
            for operation in web_bridge.poll_operations():
                s2c.put ( {'op': operation} )
            if not c2s.empty():
                input = c2s.get()
                op = input.get('op','')
                if op == 'show':
                    web_bridge.write_preview(input.get('previews'))
                elif op == 'close':
                    break
            try:
                io.process_messages(0.1)
            except KeyboardInterrupt:
                s2c.put ( {'op': 'close'} )
    else:
        wnd_name = "--- ShenNong SAEHD --- Training preview"
        io.named_window(wnd_name)
        io.capture_keys(wnd_name)

        previews = None
        loss_history = None
        selected_preview = 0
        update_preview = False
        is_showing = False
        is_waiting_preview = False
        show_last_history_iters_count = 0
        iter = 0

        while True:
            for operation in web_bridge.poll_operations():
                s2c.put ( {'op': operation} )
            if not c2s.empty():
                input = c2s.get()
                op = input['op']
                if op == 'show':
                    is_waiting_preview = False
                    loss_history = input['loss_history'] if 'loss_history' in input.keys() else None
                    previews = input['previews'] if 'previews' in input.keys() else None
                    iter = input['iter'] if 'iter' in input.keys() else 0
                    web_bridge.write_preview(previews)
                    if previews is not None:
                        max_w = 0
                        max_h = 0
                        for (preview_name, preview_rgb) in previews:
                            (h, w, c) = preview_rgb.shape
                            max_h = max (max_h, h)
                            max_w = max (max_w, w)

                        max_size = 640
                        if max_h > max_size:
                            max_w = int( max_w / (max_h / max_size) )
                            max_h = max_size

                        #make all previews size equal
                        for preview in previews[:]:
                            (preview_name, preview_rgb) = preview
                            (h, w, c) = preview_rgb.shape
                            if h != max_h or w != max_w:
                                previews.remove(preview)
                                previews.append ( (preview_name, cv2.resize(preview_rgb, (max_w, max_h))) )
                        selected_preview = selected_preview % len(previews)
                        update_preview = True
                elif op == 'close':
                    break

            if update_preview:
                update_preview = False
                # 获取当前选择的预览名称和对应的RGB数据
                selected_preview_name = previews[selected_preview][0]
                selected_preview_rgb = previews[selected_preview][1]
                # 获取预览图像的高度、宽度和通道数
                (h,w,c) = selected_preview_rgb.shape

                # HEAD
                head_lines = [
                    '[s]:保存 save          [b]:备份 backup          [enter]:退出 exit',
                    '[p]:刷新预览 update    [space]:切换预览模式 next preview',
                    '[l]: loss range        当前预览模式 Preview: "%s" [%d/%d]' % (selected_preview_name,selected_preview+1, len(previews) )
                    ]

                head_line_height = 15
                head_height = len(head_lines) * head_line_height
                head = np.ones ( (head_height,w,c) ) * 0.1# 创建头部区域的图像，初始为灰色背景

                for i in range(0, len(head_lines)):
                    t = i * head_line_height
                    b = (i + 1) * head_line_height
                    # 将文本图像叠加到头部区域
                    head[t:b, 0:w] += imagelib.get_text_image (  (head_line_height,w,c) , head_lines[i], color=[0.8]*c )

                final = head # 将头部区域作为最终的图像预览结果

                if loss_history is not None:
                    if show_last_history_iters_count == 0:
                        # 显示所有的损失历史数据
                        loss_history_to_show = loss_history
                        # 显示L快捷键区间的损失历史数据
                    else:
                        loss_history_to_show = loss_history[-show_last_history_iters_count:]

                    # 生成损失历史数据的预览图像
                    lh_img = models.ModelBase.get_loss_history_preview(loss_history_to_show, iter, w, c)
                    # 将损失历史数据的预览图像与final进行垂直拼接
                    final = np.concatenate ( [final, lh_img], axis=0 )

                # 将当前选择的预览图像与final进行垂直拼接
                final = np.concatenate ( [final, selected_preview_rgb], axis=0 )
                # 将最终图像中的像素值限制在0到1之间，确保图像数据合法
                final = np.clip(final, 0, 1)
                # 显示最终图像
                io.show_image( wnd_name, (final*255).astype(np.uint8) )
                is_showing = True

            # 获取窗口wnd_name的键盘事件
            key_events = io.get_key_events(wnd_name)
            # 获取最后一个键盘事件的相关信息
            key, chr_key, ctrl_pressed, alt_pressed, shift_pressed = key_events[-1] if len(key_events) > 0 else (0,0,False,False,False)



            if key == ord('\n') or key == ord('\r'):
                s2c.put ( {'op': 'close'} )
            elif key == ord('s'):
                s2c.put ( {'op': 'save'} )
            elif key == ord('b'):
                s2c.put ( {'op': 'backup'} )
            elif key == ord('p'):
                try:
                    cv_set_titile("--- ShenNong SAEHD --- Training preview", newTitle='--- 神农 ShenNong SAEHD --- 训练预览窗口 --- QQ交流群:')
                except:
                    pass
                if not is_waiting_preview:
                    is_waiting_preview = True
                    s2c.put ( {'op': 'preview'} )
            elif key == ord('l'):
                if show_last_history_iters_count == 0:
                    show_last_history_iters_count = 5000
                elif show_last_history_iters_count == 5000:
                    show_last_history_iters_count = 50000
                elif show_last_history_iters_count == 50000:
                    show_last_history_iters_count = 500000
                elif show_last_history_iters_count == 500000:
                    show_last_history_iters_count = 1000000
                elif show_last_history_iters_count == 1000000:
                    show_last_history_iters_count = 0
                update_preview = True
            elif key == ord(' '):
                selected_preview = (selected_preview + 1) % len(previews)
                update_preview = True

            try:
                io.process_messages(0.1)
            except KeyboardInterrupt:
                s2c.put ( {'op': 'close'} )


        io.destroy_all_windows()