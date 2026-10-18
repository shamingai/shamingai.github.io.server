export function compareArticles(left, right) {
  return left.published_on.localeCompare(right.published_on) * -1 || left.title.localeCompare(right.title, "zh-Hans-CN");
}

export function homeOrder(articles) {
  return [...articles].sort(compareArticles);
}

export function archiveYearOrder(articles) {
  return [...articles].sort((left, right) => {
    const byDate = left.published_on.localeCompare(right.published_on);
    return byDate || left.title.localeCompare(right.title, "zh-Hans-CN");
  });
}

export function parentOf(path) {
  const separator = path.lastIndexOf(" / ");
  return separator === -1 ? null : path.slice(0, separator);
}
