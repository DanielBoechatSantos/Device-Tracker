import sys
import subprocess
import threading
import webbrowser
import os
import shutil  # Para limpar temporários se necessário
from PyQt5.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, 
                             QLabel, QTextEdit, QPushButton, QHBoxLayout)
from PyQt5.QtGui import QFont, QIcon
from PyQt5.QtCore import Qt, pyqtSignal, QObject

def get_base_path():
    """ Retorna o caminho real da pasta onde o executável ou script está. """
    if getattr(sys, 'frozen', False):
        # Se for um executável .exe, retorna a pasta onde o .exe está
        return os.path.dirname(sys.executable)
    # Se for script .py, retorna a pasta do script
    return os.path.dirname(os.path.abspath(__file__))

class ProcessWorker(QObject):
    output_received = pyqtSignal(str)
    
    def __init__(self, command, cwd):
        super().__init__()
        self.command = command
        self.cwd = cwd

    def run(self):
        process = subprocess.Popen(
            self.command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=self.cwd,
            universal_newlines=True
        )

        for line in iter(process.stdout.readline, ''):
            self.output_received.emit(line)
        process.stdout.close()

class ModernTrackerGUI(QMainWindow):
    def __init__(self):
        super().__init__()
        self.base_dir = get_base_path() # Define a base correta
        self.initUI()
        
        # Inicia a verificação e instalação do NPM antes do Node
        threading.Thread(target=self.check_npm_and_start, daemon=True).start()

    def initUI(self):
        self.setWindowTitle('WhatsApp Tracker Pro - Console')
        self.setWindowIcon(QIcon(":/img/favicon.png"))
        self.setMinimumSize(800, 600)

        self.setStyleSheet("""
            QMainWindow { background-color: #0b141a; }
            QLabel { color: #e9edef; font-family: 'Segoe UI'; }
            QTextEdit { background-color: #0b141a; color: #00e676; border: 1px solid #202c33; font-family: 'Consolas'; font-size: 11pt; }
            QPushButton { background-color: #00a884; color: white; border-radius: 5px; padding: 12px; font-weight: bold; }
            QPushButton:hover { background-color: #06cf9c; }
            QPushButton#btn_exit { background-color: #ea4335; }
            QPushButton#btn_exit:hover { background-color: #ff5252; }
        """)

        self.main_widget = QWidget()
        self.setCentralWidget(self.main_widget)
        self.layout = QVBoxLayout(self.main_widget)

        self.header = QLabel("Terminal de Controle")
        self.header.setFont(QFont('Segoe UI', 14, QFont.Bold))
        self.layout.addWidget(self.header)

        self.console = QTextEdit()
        self.console.setReadOnly(True)
        self.layout.addWidget(self.console)

        # Layout de Botões
        self.button_layout = QHBoxLayout()
        
        self.btn_web = QPushButton("ABRIR PAINEL WEB")
        self.btn_web.clicked.connect(lambda: webbrowser.open("http://localhost:3001"))
        
        self.btn_exit = QPushButton("ENCERRAR APLICAÇÃO")
        self.btn_exit.setObjectName("btn_exit")
        self.btn_exit.clicked.connect(self.close_application)
        
        self.button_layout.addWidget(self.btn_web)
        self.button_layout.addWidget(self.btn_exit)
        self.layout.addLayout(self.button_layout)

    def check_npm_and_start(self):
        """ Verifica node_modules e roda npm install se necessário """
        node_modules_path = os.path.join(self.base_dir, "node_modules")
        
        if not os.path.exists(node_modules_path):
            self.update_console(">>> Pasta 'node_modules' não encontrada. Iniciando 'npm install'...\n")
            try:
                # Roda o npm install e aguarda terminar
                subprocess.check_call("npm install", shell=True, cwd=self.base_dir)
                self.update_console(">>> Instalação concluída com sucesso!\n")
            except Exception as e:
                self.update_console(f">>> ERRO ao rodar npm install: {str(e)}\n")
                return

        self.start_node_process()

    def start_node_process(self):
        server_file = os.path.join(self.base_dir, "src", "server.ts")
        
        if not os.path.exists(server_file):
            self.update_console(f"ERRO: Arquivo {server_file} não encontrado!")
            return

        cmd = f'node --loader ts-node/esm "{server_file}"'
        
        self.worker = ProcessWorker(cmd, self.base_dir)
        self.worker.output_received.connect(self.update_console)
        self.worker.run() # Roda no thread atual (que já é uma thread separada)

    def update_console(self, text):
        # Garante que a atualização da UI ocorra na thread principal
        self.console.append(text) 
        self.console.verticalScrollBar().setValue(self.console.verticalScrollBar().maximum())

    def close_application(self):
        """ Encerra o processo e tenta limpar arquivos temporários se necessário """
        self.console.append("\n>>> Encerrando processos...")
        # Aqui você pode adicionar lógica para deletar pastas de cache se o seu app criar
        # Exemplo: shutil.rmtree(os.path.join(self.base_dir, 'temp_cache'), ignore_errors=True)
        
        QApplication.quit()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    gui = ModernTrackerGUI()
    gui.show()
    sys.exit(app.exec_())