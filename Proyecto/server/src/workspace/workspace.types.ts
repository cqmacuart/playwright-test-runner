export type TreeNode = {
  name: string;
  type: "file" | "folder";
  relativePath: string;
  hasChildren?: boolean;
};
