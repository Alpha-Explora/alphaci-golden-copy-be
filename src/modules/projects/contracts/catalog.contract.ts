export interface CatalogTemplateContract {
  id: string;
  name: string;
  description: string;
  stack: string;
  categories: string[];
  filePatterns: string[];
}
