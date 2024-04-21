// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';

import {
    ConfigurationTarget,
    NotebookCellData,
    NotebookCellKind,
    NotebookDocument,
    NotebookEdit,
    NotebookRange,
    Uri,
    WorkspaceEdit,
    commands,
    window,
    workspace
} from 'vscode';
import { IConfigurationService, IDataScienceCommandListener, IDisposableRegistry } from '../platform/common/types';
import { Commands, JVSC_EXTENSION_ID } from '../platform/common/constants';
import { noop } from '../platform/common/utils/misc';
import { NotebookCellLanguageService } from './languages/cellLanguageService';
import { DisplayOptions } from '../kernels/displayOptions';
import { IKernel, IKernelProvider } from '../kernels/types';
import { getDisplayPath } from '../platform/common/platform/fs-paths';
import { DataScience } from '../platform/common/utils/localize';
import { traceInfo, traceVerbose } from '../platform/logging';
import { INotebookEditorProvider } from './types';
import { IServiceContainer } from '../platform/ioc/types';
import { endCellAndDisplayErrorsInCell } from '../kernels/execution/helpers';
import { chainWithPendingUpdates } from '../kernels/execution/notebookUpdater';
import { IDataScienceErrorHandler } from '../kernels/errors/types';
import { getNotebookMetadata } from '../platform/common/utils';
import { KernelConnector } from './controllers/kernelConnector';
import { IControllerRegistration } from './controllers/types';
import { ServiceContainer } from '../platform/ioc/container';

/**
 * Registers commands specific to the notebook UI
 */
@injectable()
export class NotebookCommandListener implements IDataScienceCommandListener {
    private kernelInterruptedDontAskToRestart: boolean = false;
    constructor(
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(NotebookCellLanguageService) private readonly languageService: NotebookCellLanguageService,
        @inject(IConfigurationService) private configurationService: IConfigurationService,
        @inject(IKernelProvider) private kernelProvider: IKernelProvider,
        @inject(IControllerRegistration) private controllerRegistration: IControllerRegistration,
        @inject(IDataScienceErrorHandler) private errorHandler: IDataScienceErrorHandler,
        @inject(INotebookEditorProvider) private notebookEditorProvider: INotebookEditorProvider,
        @inject(IServiceContainer) private serviceContainer: IServiceContainer
    ) { }

    public register(): void {
        this.disposableRegistry.push(
            commands.registerCommand(Commands.NotebookEditorRemoveAllCells, () => this.removeAllCells())
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.NotebookEditorRunAllCells, () => this.runAllCells())
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.NotebookEditorAddCellBelow, () => this.addCellBelow())
        );
        this.disposableRegistry.push(
            // TODO: if contributed anywhere, add context support
            commands.registerCommand(Commands.RestartKernelAndRunUpToSelectedCell, () =>
                this.restartKernelAndRunUpToSelectedCell()
            )
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiInsertCellAbove, async (uri, num, kind, content) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    const defaultLanguage = this.languageService.getPreferredLanguage(getNotebookMetadata(notebook));

                    const edit = new WorkspaceEdit();
                    const nbEdit = NotebookEdit.insertCells(num, [
                        new NotebookCellData(kind == 2 ? NotebookCellKind.Code : NotebookCellKind.Markup,
                            content,
                            defaultLanguage)
                    ]);

                    edit.set(notebook.uri, [nbEdit]);
                    return workspace.applyEdit(edit);
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiInsertCellBelow, async (uri, num, kind, content) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    const defaultLanguage = this.languageService.getPreferredLanguage(getNotebookMetadata(notebook));
                    const edit = new WorkspaceEdit();
                    const nbEdit = NotebookEdit.insertCells(num + 1, [
                        new NotebookCellData(kind == 2 ? NotebookCellKind.Code : NotebookCellKind.Markup,
                            content,
                            defaultLanguage)
                    ]);

                    edit.set(notebook.uri, [nbEdit]);
                    return workspace.applyEdit(edit);
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiGetCell, async (uri, num) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    return notebook?.cellAt(num)?.document?.getText();
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiGetCellOutput, async (uri, num) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    const output = notebook?.cellAt(num)?.outputs?.[0]?.items?.[0]?.data;
                    if (!output) {
                        return false;
                    }
                    return (new TextDecoder().decode(output));
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiGetCellType, async (uri, num) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    return notebook?.cellAt(num)?.kind || false;
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiUpdateCell, async (uri, num, kind, content) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    const defaultLanguage = this.languageService.getPreferredLanguage(getNotebookMetadata(notebook));

                    const edit = new WorkspaceEdit();
                    const nbEdit = NotebookEdit.replaceCells(new NotebookRange(num, num + 1), [
                        new NotebookCellData(kind == 2 ? NotebookCellKind.Code : NotebookCellKind.Markup,
                            content,
                            defaultLanguage)
                    ]);

                    edit.set(notebook.uri, [nbEdit]);
                    return workspace.applyEdit(edit);
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiDeleteCell, async (uri, num) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    const edit = new WorkspaceEdit();
                    const nbEdit = NotebookEdit.deleteCells(new NotebookRange(num, num + 1));
                    edit.set(notebook.uri, [nbEdit]);
                    return workspace.applyEdit(edit);
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiRunCell, async (uri, num) => {
                const notebook = await this.aiGetNotebook(uri);
                num = parseInt(num);
                if (this.aiCheckConditions(notebook, num)) {
                    return commands.executeCommand(
                        'notebook.cell.execute',
                        { start: num, end: num + 1 },
                        notebook.uri
                    );
                }
                return false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiGetAllKernel, () => {
                const controllers = ServiceContainer.instance.get<IControllerRegistration>(IControllerRegistration);
                return controllers.all;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiGetKernel, (id) => {
                const controllers = ServiceContainer.instance.get<IControllerRegistration>(IControllerRegistration);
                const filtered = controllers.all.filter(controller => controller.id == id);
                return filtered?.[0] || false;
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiSelectKernel, async (id) => {
                return await commands.executeCommand('notebook.selectKernel', {
                    id: id,
                    extension: JVSC_EXTENSION_ID
                });
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiRestartKernel, async (uri) => {
                const notebook = await this.aiGetNotebook(uri);

                return this.aiRestartKernel(notebook.uri).catch(noop);
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(Commands.AiInterruptKernel, async (uri) => {
                const notebook = await this.aiGetNotebook(uri);
                return this.interruptKernel(notebook.uri);
            })
        );

        this.disposableRegistry.push(
            commands.registerCommand(
                Commands.RestartKernel,
                (context?: { notebookEditor: { notebookUri: Uri } } | Uri) => {
                    if (context && 'notebookEditor' in context) {
                        return this.restartKernel(context?.notebookEditor?.notebookUri).catch(noop);
                    } else {
                        return this.restartKernel(context).catch(noop);
                    }
                }
            )
        );
        this.disposableRegistry.push(
            commands.registerCommand(Commands.InterruptKernel, (context?: { notebookEditor: { notebookUri: Uri } }) =>
                this.interruptKernel(context?.notebookEditor?.notebookUri)
            )
        );
        this.disposableRegistry.push(
            commands.registerCommand(
                Commands.RestartKernelAndRunAllCells,
                (context?: { notebookEditor: { notebookUri: Uri } }) => {
                    if (context && 'notebookEditor' in context) {
                        this.restartKernelAndRunAllCells(context?.notebookEditor?.notebookUri).catch(noop);
                    } else {
                        this.restartKernelAndRunAllCells(context).catch(noop);
                    }
                }
            )
        );
    }
    private async aiGetNotebook(uri: Uri): Promise<NotebookDocument> {
        if (!uri) {
            return window.visibleNotebookEditors?.[0]?.notebook;
        }
        return workspace.openNotebookDocument(uri);
    }

    private aiCheckConditions(notebook: NotebookDocument, num: number) {
        return notebook && num > 0 && num < notebook?.cellCount;
    }

    private runAllCells() {
        if (window.activeNotebookEditor) {
            commands.executeCommand('notebook.execute').then(noop, noop);
        }
    }

    private addCellBelow() {
        if (window.activeNotebookEditor) {
            commands.executeCommand('notebook.cell.insertCodeCellBelow').then(noop, noop);
        }
    }

    private removeAllCells() {
        const document = window.activeNotebookEditor?.notebook;
        if (!document) {
            return;
        }
        const defaultLanguage = this.languageService.getPreferredLanguage(getNotebookMetadata(document));
        chainWithPendingUpdates(document, (edit) => {
            const nbEdit = NotebookEdit.replaceCells(new NotebookRange(0, document.cellCount), [
                new NotebookCellData(NotebookCellKind.Code, '', defaultLanguage)
            ]);
            edit.set(document.uri, [nbEdit]);
        }).then(noop, noop);
    }
    private async interruptKernel(notebookUri: Uri | undefined): Promise<void> {
        const uri = notebookUri ?? this.notebookEditorProvider.activeNotebookEditor?.notebook.uri;
        const document = workspace.notebookDocuments.find((document) => document.uri.toString() === uri?.toString());

        if (document === undefined) {
            return;
        }
        traceVerbose(`Command interrupted kernel for ${getDisplayPath(document.uri)}`);

        const kernel = this.kernelProvider.get(document);
        if (!kernel) {
            traceInfo(`Interrupt requested & no kernel.`);
            return;
        }
        await this.wrapKernelMethod('interrupt', kernel);
    }

    private async restartKernelAndRunAllCells(notebookUri: Uri | undefined) {
        await this.restartKernel(notebookUri);
        this.runAllCells();
    }

    private async restartKernelAndRunUpToSelectedCell() {
        const activeNBE = this.notebookEditorProvider.activeNotebookEditor;

        if (activeNBE) {
            await this.restartKernel(activeNBE.notebook.uri);
            commands
                .executeCommand('notebook.cell.execute', {
                    ranges: [{ start: 0, end: activeNBE.selection.end }],
                    document: activeNBE.notebook.uri
                })
                .then(noop, noop);
        }
    }

    private async aiRestartKernel(notebookUri: Uri | undefined): Promise<void> {
        const uri = notebookUri ?? this.notebookEditorProvider.activeNotebookEditor?.notebook.uri;
        const document = workspace.notebookDocuments.find((document) => document.uri.toString() === uri?.toString());

        if (document === undefined) {
            return;
        }

        const kernel = this.kernelProvider.get(document);

        if (kernel) {
            traceVerbose(`AI restart kernel command handler for ${getDisplayPath(document.uri)}`);
            this.wrapKernelMethod('restart', kernel).catch(noop);
        }
    }

    private async restartKernel(notebookUri: Uri | undefined): Promise<void> {
        const uri = notebookUri ?? this.notebookEditorProvider.activeNotebookEditor?.notebook.uri;
        const document = workspace.notebookDocuments.find((document) => document.uri.toString() === uri?.toString());

        if (document === undefined) {
            return;
        }

        const kernel = this.kernelProvider.get(document);

        if (kernel) {
            traceVerbose(`Restart kernel command handler for ${getDisplayPath(document.uri)}`);
            if (await this.shouldAskForRestart(document.uri)) {
                // Ask the user if they want us to restart or not.
                const message = DataScience.restartKernelMessage;
                const yes = DataScience.restartKernelMessageYes;
                const dontAskAgain = DataScience.restartKernelMessageDontAskAgain;

                const response = await window.showInformationMessage(message, { modal: true }, yes, dontAskAgain);
                if (response === dontAskAgain) {
                    await this.disableAskForRestart(document.uri);
                    this.wrapKernelMethod('restart', kernel).catch(noop);
                } else if (response === yes) {
                    this.wrapKernelMethod('restart', kernel).catch(noop);
                }
            } else {
                this.wrapKernelMethod('restart', kernel).catch(noop);
            }
        }
    }

    private readonly pendingRestartInterrupt = new WeakMap<IKernel, Promise<void>>();
    private async wrapKernelMethod(currentContext: 'interrupt' | 'restart', kernel: IKernel) {
        const notebook = kernel.notebook;
        // We don't want to create multiple restarts/interrupt requests for the same kernel.
        const pendingPromise = this.pendingRestartInterrupt.get(kernel);
        if (pendingPromise) {
            return pendingPromise;
        }
        const promise = (async () => {
            // Get currently executing cell and controller
            const currentCell = this.kernelProvider.getKernelExecution(kernel).pendingCells[0];
            const controller = this.controllerRegistration.getSelected(notebook);
            try {
                if (!controller) {
                    throw new Error('No kernel associated with the notebook');
                }
                // Wrap the restart/interrupt in a loop that allows the user to switch
                await KernelConnector.wrapKernelMethod(
                    controller.connection,
                    currentContext,
                    kernel.creator,
                    this.serviceContainer,
                    { resource: kernel.resourceUri, notebook, controller: controller.controller },
                    new DisplayOptions(false),
                    this.disposableRegistry
                );
            } catch (ex) {
                if (currentCell) {
                    await endCellAndDisplayErrorsInCell(
                        currentCell,
                        kernel.controller,
                        await this.errorHandler.getErrorMessageForDisplayInCell(ex, currentContext, kernel.resourceUri),
                        false
                    );
                } else {
                    window.showErrorMessage(ex.toString()).then(noop, noop);
                }
            }
        })();
        promise
            .finally(() => {
                if (this.pendingRestartInterrupt.get(kernel) === promise) {
                    this.pendingRestartInterrupt.delete(kernel);
                }
            })
            .catch(noop);
        this.pendingRestartInterrupt.set(kernel, promise);
        return promise;
    }

    private async shouldAskForRestart(notebookUri: Uri): Promise<boolean> {
        if (this.kernelInterruptedDontAskToRestart) {
            return false;
        }
        const settings = this.configurationService.getSettings(notebookUri);
        return settings && settings.askForKernelRestart === true;
    }

    private async disableAskForRestart(notebookUri: Uri): Promise<void> {
        const settings = this.configurationService.getSettings(notebookUri);
        if (settings) {
            this.configurationService
                .updateSetting('askForKernelRestart', false, undefined, ConfigurationTarget.Global)
                .catch(noop);
        }
    }
}
