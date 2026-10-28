/**
 * `@intentius/chant-lexicon-terraform/template` (#4652): a template request
 * (`@intentius/chant/template-request`) as Terraform files, an app's new
 * root or an add-on's module call in it. Nothing here reads the disk.
 */

export {
  renderAppRoot,
  renderAddonCall,
  terraformInputType,
  addonFile,
  TemplateRenderError,
  APP_MODULE_NAME,
  APP_OUTPUT_PREFIX,
  APP_ROOT_FILE,
} from "./render";
export type { RenderAppRootOptions, RenderAddonCallOptions, RenderedFile, TemplateOutput, TemplateRenderErrorCode } from "./render";
