import { computed } from "nanostores";
import { nanoid } from "nanoid";
import slugify from "slugify";
import { createRootFolder } from "@webstudio-is/project-build";
import {
  type Page,
  type PageTemplate,
  type Folder,
  type WebstudioData,
  Pages,
  findPageByIdOrPath,
  getPagePath,
  findParentFolderByChildId,
  encodeDataSourceVariable,
  ROOT_FOLDER_ID,
  isRootFolder,
  ROOT_INSTANCE_ID,
  systemParameter,
  SYSTEM_VARIABLE_ID,
} from "@webstudio-is/sdk";
import { removeByMutable } from "~/shared/array-utils";
import {
  deleteInstanceMutable,
  extractWebstudioFragment,
  insertWebstudioFragmentCopy,
  updateWebstudioData,
} from "~/shared/instance-utils";
import {
  $dataSources,
  $pages,
  $variableValuesByInstanceSelector,
} from "~/shared/nano-states";
import {
  insertPageCopyMutable,
  insertPageFromTemplateMutable,
} from "~/shared/page-utils";
import {
  $selectedPage,
  getInstanceKey,
  getInstancePath,
  selectPage,
} from "~/shared/awareness";

export const nameToPath = (pages: Pages | undefined, name: string) => {
  if (name === "") {
    return "";
  }
  const slug = slugify(name, { lower: true, strict: true });
  const path = `/${slug}`;
  if (pages === undefined) {
    return path;
  }
  if (findPageByIdOrPath(path, pages) === undefined) {
    return path;
  }
  let suffix = 1;
  while (findPageByIdOrPath(`${path}${suffix}`, pages) !== undefined) {
    suffix++;
  }
  return `${path}${suffix}`;
};

/**
 * When page or folder needs to be deleted or moved to a different parent,
 * we want to cleanup any existing reference to it in current folder.
 * We could do this in just one folder, but I think its more robust to check all,
 * just in case we got double referencing.
 */
export const cleanupChildRefsMutable = (
  id: Folder["id"] | Page["id"],
  folders: Array<Folder>
) => {
  for (const folder of folders) {
    const index = folder.children.indexOf(id);
    if (index !== -1) {
      // Not exiting here just to be safe and check all folders even though it should be impossible
      // to have the same id in multiple folders.
      folder.children.splice(index, 1);
    }
  }
};

/**
 * When page or folder is found and its not referenced in any other folder children,
 * we consider it orphaned due to collaborative changes and we put it into the root folder.
 */
export const reparentOrphansMutable = (pages: Pages) => {
  const children = [ROOT_FOLDER_ID];
  for (const folder of pages.folders) {
    children.push(...folder.children);
  }

  let rootFolder = pages.folders.find(isRootFolder);
  // Should never happen, but just in case.
  if (rootFolder === undefined) {
    rootFolder = createRootFolder();
    pages.folders.push(rootFolder);
  }

  for (const folder of pages.folders) {
    // It's an orphan
    if (children.includes(folder.id) === false) {
      rootFolder.children.push(folder.id);
    }
  }

  for (const page of pages.pages) {
    // It's an orphan
    if (children.includes(page.id) === false) {
      rootFolder.children.push(page.id);
    }
  }
};

/**
 * Returns true if folder's slug is unique within it's future parent folder.
 * Needed to verify if the folder can be nested under the parent folder without modifying slug.
 */
export const isSlugAvailable = (
  slug: string,
  folders: Array<Folder>,
  parentFolderId: Folder["id"],
  // undefined folder id means new folder
  folderId?: Folder["id"]
) => {
  // Empty slug can appear any amount of times.
  if (slug === "") {
    return true;
  }
  const foldersMap = new Map(folders.map((folder) => [folder.id, folder]));
  const parentFolder = foldersMap.get(parentFolderId);
  // Should be impossible because at least root folder is always found.
  if (parentFolder === undefined) {
    return false;
  }

  return (
    parentFolder.children.some(
      (id) => foldersMap.get(id)?.slug === slug && id !== folderId
    ) === false
  );
};

export const isPathAvailable = ({
  pages,
  path,
  parentFolderId,
  pageId,
}: {
  pages: Pages;
  path: Page["path"];
  parentFolderId: Folder["id"];
  // undefined page id means new page
  pageId?: Page["id"];
}) => {
  const map = new Map<Page["path"], Page>();
  const allPages = [pages.homePage, ...pages.pages];
  for (const page of allPages) {
    map.set(getPagePath(page.id, pages), page);
  }
  const folderPath = getPagePath(parentFolderId, pages);
  // When slug is empty, folderPath is "/".
  const pagePath = folderPath === "/" ? path : `${folderPath}${path}`;
  const existingPage = map.get(pagePath);
  // We found another page that has the same path and the current page.
  if (pageId && existingPage?.id === pageId) {
    return true;
  }
  return existingPage === undefined;
};

/**
 * - Register a folder or a page inside children of a given parent folder.
 * - Fallback to a root folder.
 * - Cleanup any potential references in other folders.
 */
export const registerFolderChildMutable = (
  folders: Array<Folder>,
  id: Page["id"] | Folder["id"],
  // In case we couldn't find the current folder during update for any reason,
  // we will always fall back to the root folder.
  parentFolderId?: Folder["id"]
) => {
  const parentFolder =
    folders.find((folder) => folder.id === parentFolderId) ??
    folders.find(isRootFolder);
  cleanupChildRefsMutable(id, folders);
  parentFolder?.children.push(id);
};

export const reparentPageOrFolderMutable = (
  folders: Folder[],
  pageOrFolderId: string,
  newFolderId: string,
  newPosition: number
) => {
  const childrenAndSelf = getAllChildrenAndSelf(
    pageOrFolderId,
    folders,
    "folder"
  );
  // make sure target folder is not self or descendants
  if (childrenAndSelf.includes(newFolderId)) {
    return;
  }
  const prevParent = findParentFolderByChildId(pageOrFolderId, folders);
  const nextParent = folders.find((folder) => folder.id === newFolderId);
  if (prevParent === undefined || nextParent === undefined) {
    return;
  }
  // if parent is the same, we need to adjust the position
  // to account for the removal of the instance.
  const prevPosition = prevParent.children.indexOf(pageOrFolderId);
  if (prevParent.id === nextParent.id && prevPosition < newPosition) {
    newPosition -= 1;
  }
  prevParent.children.splice(prevPosition, 1);
  nextParent.children.splice(newPosition, 0, pageOrFolderId);
};

/**
 * Get all child folder ids of the current folder including itself.
 */
export const getAllChildrenAndSelf = (
  id: Folder["id"] | Page["id"],
  folders: Array<Folder>,
  filter: "folder" | "page"
) => {
  const child = folders.find((folder) => folder.id === id);
  const children: Array<Folder["id"]> = [];
  const type = child === undefined ? "page" : "folder";

  if (type === filter) {
    children.push(id);
  }

  if (child) {
    for (const childId of child.children) {
      children.push(...getAllChildrenAndSelf(childId, folders, filter));
    }
  }
  return children;
};

/**
 * Deletes a page.
 */
export const deletePageMutable = (pageId: Page["id"], data: WebstudioData) => {
  const { pages } = data;
  // deselect page before deleting to avoid flash of content
  if ($selectedPage.get()?.id === pageId) {
    selectPage(pages.homePage.id);
  }
  const rootInstanceId = findPageByIdOrPath(pageId, pages)?.rootInstanceId;
  if (rootInstanceId !== undefined) {
    deleteInstanceMutable(
      data,
      getInstancePath([rootInstanceId], data.instances)
    );
  }
  removeByMutable(pages.pages, (page) => page.id === pageId);
  cleanupChildRefsMutable(pageId, pages.folders);
};

/**
 * Deletes folder and child folders.
 * Doesn't delete pages, only returns pageIds.
 */
export const deleteFolderWithChildrenMutable = (
  folderId: Folder["id"],
  folders: Array<Folder>
) => {
  const folderIds = getAllChildrenAndSelf(folderId, folders, "folder");
  const pageIds = getAllChildrenAndSelf(folderId, folders, "page");
  for (const folderId of folderIds) {
    cleanupChildRefsMutable(folderId, folders);
    removeByMutable(folders, (folder) => folder.id === folderId);
  }

  return {
    folderIds,
    pageIds,
  };
};

export const $pageRootScope = computed(
  [$selectedPage, $variableValuesByInstanceSelector, $dataSources],
  (page, variableValuesByInstanceSelector, dataSources) => {
    const scope: Record<string, unknown> = {};
    const aliases = new Map<string, string>();
    const defaultValues = new Map<string, unknown>();
    if (page === undefined) {
      return { variableValues: defaultValues, scope, aliases };
    }
    const values =
      variableValuesByInstanceSelector.get(
        getInstanceKey([page.rootInstanceId, ROOT_INSTANCE_ID])
      ) ?? new Map<string, unknown>();
    for (const [dataSourceId, value] of values) {
      let dataSource = dataSources.get(dataSourceId);
      if (dataSourceId === SYSTEM_VARIABLE_ID) {
        dataSource = systemParameter;
      }
      if (dataSource === undefined) {
        continue;
      }
      const name = encodeDataSourceVariable(dataSourceId);
      scope[name] = value;
      aliases.set(name, dataSource.name);
    }
    return { variableValues: values, scope, aliases };
  }
);

export const duplicatePage = (pageId: Page["id"]) => {
  const pages = $pages.get();
  const currentFolder = findParentFolderByChildId(pageId, pages?.folders ?? []);
  if (currentFolder === undefined) {
    return;
  }
  let newPageId: undefined | string;
  updateWebstudioData((data) => {
    newPageId = insertPageCopyMutable({
      source: { data, pageId },
      target: { data, folderId: currentFolder.id },
    });
  });
  return newPageId;
};

const deduplicateName = (usedNames: Set<string>, name: string) => {
  const { name: baseName = name, copyNumber } =
    // extract a number from "name (copyNumber)"
    name.match(/^(?<name>.+) \((?<copyNumber>\d+)\)$/)?.groups ?? {};
  let nameNumber = Number(copyNumber ?? "0");
  let newName: string;
  do {
    nameNumber += 1;
    newName = `${baseName} (${nameNumber})`;
  } while (usedNames.has(newName));
  return newName;
};

const deduplicateSlug = (usedSlugs: Set<string>, slug: string) => {
  // extract a number from "slug-N"
  const { slug: baseSlug = slug, copyNumber } =
    slug.match(/^(?<slug>.+)-(?<copyNumber>\d+)$/)?.groups ?? {};
  let counter = Number(copyNumber ?? "0");
  let newSlug: string;
  do {
    counter += 1;
    newSlug = baseSlug ? `${baseSlug}-${counter}` : `copy-${counter}`;
  } while (usedSlugs.has(newSlug));
  return newSlug;
};

const insertFolderCopyMutable = ({
  source,
  target,
}: {
  source: { data: WebstudioData; folderId: Folder["id"] };
  target: { data: WebstudioData; parentFolderId: Folder["id"] };
}): Folder["id"] | undefined => {
  const sourceFolder = source.data.pages.folders.find(
    (folder) => folder.id === source.folderId
  );
  if (sourceFolder === undefined) {
    return;
  }

  const parentFolder = target.data.pages.folders.find(
    (folder) => folder.id === target.parentFolderId
  );
  const usedNames = new Set<string>();
  const usedSlugs = new Set<string>();
  for (const childId of parentFolder?.children ?? []) {
    const childFolder = target.data.pages.folders.find(
      (folder) => folder.id === childId
    );
    if (childFolder) {
      usedNames.add(childFolder.name);
      usedSlugs.add(childFolder.slug);
      continue;
    }
    const childPage = target.data.pages.pages.find(
      (page) => page.id === childId
    );
    if (childPage) {
      usedNames.add(childPage.name);
    }
  }

  // Create new folder with deduplicated name and slug
  const newFolderId = nanoid();
  const newFolder: Folder = {
    id: newFolderId,
    name: deduplicateName(usedNames, sourceFolder.name),
    slug: deduplicateSlug(usedSlugs, sourceFolder.slug),
    children: [],
  };

  // Add new folder to the folders array
  target.data.pages.folders.push(newFolder);

  // Register new folder in parent
  for (const folder of target.data.pages.folders) {
    if (folder.id === target.parentFolderId) {
      folder.children.push(newFolderId);
    }
  }

  // Duplicate all children (pages and nested folders)
  for (const childId of sourceFolder.children) {
    const childFolder = source.data.pages.folders.find(
      (folder) => folder.id === childId
    );

    if (childFolder) {
      // It's a nested folder - duplicate it recursively
      insertFolderCopyMutable({
        source: { data: source.data, folderId: childId },
        target: { data: target.data, parentFolderId: newFolderId },
      });
    } else {
      // It's a page - duplicate it
      insertPageCopyMutable({
        source: { data: source.data, pageId: childId },
        target: { data: target.data, folderId: newFolderId },
      });
    }
  }

  return newFolderId;
};

export const duplicateFolder = (folderId: Folder["id"]) => {
  const pages = $pages.get();
  const currentFolder = findParentFolderByChildId(
    folderId,
    pages?.folders ?? []
  );
  if (currentFolder === undefined) {
    return;
  }
  let newFolderId: undefined | string;
  updateWebstudioData((data) => {
    newFolderId = insertFolderCopyMutable({
      source: { data, folderId },
      target: { data, parentFolderId: currentFolder.id },
    });
  });
  return newFolderId;
};

export const isFolder = (id: string, folders: Array<Folder>) => {
  return folders.some((folder) => folder.id === id);
};

type DropTarget = {
  parentId: string;
  beforeId?: string;
  afterId?: string;
  indexWithinChildren: number;
};

type TreeDropTarget = {
  parentLevel: number;
  beforeLevel?: number;
  afterLevel?: number;
};

export const getStoredDropTarget = (
  selector: string[],
  dropTarget: TreeDropTarget
): undefined | DropTarget => {
  const parentId = selector.at(-dropTarget.parentLevel - 1);
  const beforeId =
    dropTarget.beforeLevel === undefined
      ? undefined
      : selector.at(-dropTarget.beforeLevel - 1);
  const afterId =
    dropTarget.afterLevel === undefined
      ? undefined
      : selector.at(-dropTarget.afterLevel - 1);
  const pages = $pages.get();
  const parentFolder = pages?.folders.find((item) => item.id === parentId);
  let indexWithinChildren = 0;
  if (parentFolder) {
    const beforeIndex = parentFolder.children.indexOf(beforeId ?? "");
    const afterIndex = parentFolder.children.indexOf(afterId ?? "");
    if (beforeIndex > -1) {
      indexWithinChildren = beforeIndex;
    } else if (afterIndex > -1) {
      indexWithinChildren = afterIndex + 1;
    }
  }
  if (parentId) {
    return { parentId, beforeId, afterId, indexWithinChildren };
  }
};

export const canDrop = (dropTarget: DropTarget, folders: Folder[]) => {
  // allow dropping only inside folders
  if (isFolder(dropTarget.parentId, folders) === false) {
    return false;
  }
  // forbid dropping in the beginning of root folder
  // which is always used by home page
  if (
    isRootFolder({ id: dropTarget.parentId }) &&
    dropTarget.indexWithinChildren === 0
  ) {
    return false;
  }
  return true;
};

export const deleteTemplateMutable = (
  templateId: PageTemplate["id"],
  data: WebstudioData
) => {
  const template = data.pages.pageTemplates?.find((t) => t.id === templateId);
  if (template === undefined) {
    return;
  }
  deleteInstanceMutable(
    data,
    getInstancePath([template.rootInstanceId], data.instances)
  );
  data.pages.pageTemplates = data.pages.pageTemplates?.filter(
    (t) => t.id !== templateId
  );
};

export const duplicateTemplate = (templateId: PageTemplate["id"]) => {
  const pages = $pages.get();
  const template = pages?.pageTemplates?.find((t) => t.id === templateId);
  if (template === undefined) {
    return;
  }
  let newTemplateId: undefined | string;
  updateWebstudioData((data) => {
    data.pages.pageTemplates ??= [];
    const usedNames = new Set(data.pages.pageTemplates.map((t) => t.name));
    const { name: baseName = template.name, copyNumber } =
      template.name.match(/^(?<name>.+) \((?<copyNumber>\d+)\)$/)?.groups ?? {};
    let nameNumber = Number(copyNumber ?? "0");
    let newName = baseName;
    while (usedNames.has(newName)) {
      nameNumber += 1;
      newName = `${baseName} (${nameNumber})`;
    }
    newTemplateId = nanoid();
    const { newInstanceIds } = insertWebstudioFragmentCopy({
      data,
      fragment: extractWebstudioFragment(data, template.rootInstanceId),
      availableVariables: [],
      projectId: newTemplateId,
    });
    const newTemplate: PageTemplate = {
      id: newTemplateId,
      name: newName,
      title: template.title,
      rootInstanceId:
        newInstanceIds.get(template.rootInstanceId) ?? template.rootInstanceId,
      meta: structuredClone(template.meta),
    };
    data.pages.pageTemplates.push(newTemplate);
  });
  return newTemplateId;
};

export const instantiateTemplate = ({
  templateId,
  overrides,
  folderId,
}: {
  templateId: PageTemplate["id"];
  overrides: { name: string; path: string };
  folderId: Folder["id"];
}) => {
  let newPageId: undefined | string;
  updateWebstudioData((data) => {
    newPageId = insertPageFromTemplateMutable({
      templateId,
      source: { data },
      target: { data, folderId },
      overrides,
    });
  });
  return newPageId;
};

export const instantiateTemplateAsNewPage = (
  templateId: PageTemplate["id"]
) => {
  const pages = $pages.get();
  const template = pages?.pageTemplates?.find((t) => t.id === templateId);
  if (pages === undefined || template === undefined) {
    return;
  }
  const rootFolder = pages.folders.find(isRootFolder);
  const usedNames = new Set<string>();
  for (const childId of rootFolder?.children ?? []) {
    const page = findPageByIdOrPath(childId, pages);
    if (page) {
      usedNames.add(page.name);
    }
  }
  let name = template.name;
  let nameNum = 1;
  while (usedNames.has(name)) {
    name = `${template.name} (${nameNum})`;
    nameNum += 1;
  }
  return instantiateTemplate({
    templateId,
    overrides: { name, path: nameToPath(pages, template.name) },
    folderId: ROOT_FOLDER_ID,
  });
};
